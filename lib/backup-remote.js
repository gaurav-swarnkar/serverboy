// Off-server storage for backups: any S3-compatible service (AWS S3, Cloudflare R2, Backblaze B2,
// Wasabi, MinIO, DigitalOcean Spaces) or Azure Blob Storage.
//
// The keys never leave Serverboy. For each file Serverboy makes a short-lived signed URL and the
// managed server uploads / downloads with curl straight to the cloud (no data goes through
// Serverboy). Listing and deleting are done by Serverboy itself.
const crypto = require('crypto');
const { HttpError } = require('./ssh');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding as AWS wants it (encodeURIComponent leaves !'()* alone).
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encPath = (key) => key.split('/').map(enc).join('/');

function cleanPrefix(p) {
  return String(p || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

// ---------------- S3 (Signature Version 4, query-string signing) ----------------

function s3Base(cfg) {
  let endpoint = String(cfg.endpoint || '').trim().replace(/\/+$/, '');
  const region = String(cfg.region || '').trim() || 'us-east-1';
  if (!endpoint) endpoint = region === 'us-east-1' ? 'https://s3.amazonaws.com' : `https://s3.${region}.amazonaws.com`;
  if (!/^https?:\/\//.test(endpoint)) endpoint = `https://${endpoint}`;
  const u = new URL(endpoint);
  // AWS: bucket in the host name. Others (R2, B2, MinIO, …): bucket in the path, which they all support.
  const virtual = cfg.pathStyle === undefined ? /(^|\.)amazonaws\.com$/.test(u.hostname) : !cfg.pathStyle;
  return { u, region, virtual };
}

// A signed URL for one request. `query` holds extra (unsigned-by-name) query parameters.
function s3Presign(cfg, method, key, { expires = 3600, query = {}, now = new Date() } = {}) {
  const { u, region, virtual } = s3Base(cfg);
  const bucket = String(cfg.bucket || '').trim();
  const host = virtual ? `${bucket}.${u.host}` : u.host;
  const basePath = u.pathname.replace(/\/+$/, '');
  const path = `${basePath}${virtual ? '' : `/${enc(bucket)}`}/${key ? encPath(key) : ''}`;
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const params = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${cfg.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join('&');
  const canonical = [method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return `${u.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const xmlAll = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const xmlOne = (xml, tag) => xmlAll(xml, tag)[0];
const unxml = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function cloudFetch(url, opts = {}) {
  let res;
  try {
    res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new HttpError(502, `Could not reach the storage service: ${err.cause?.message || err.message}`);
  }
  if (!res.ok && !(opts.method === 'DELETE' && res.status === 404)) {
    const body = await res.text().catch(() => '');
    const code = xmlOne(body, 'Code') || '';
    const msg = unxml(xmlOne(body, 'Message') || body.slice(0, 200));
    const hint = res.status === 403 ? ' Check the access key, secret and bucket permissions.' : res.status === 404 ? ' Check the bucket / container name and endpoint.' : '';
    throw new HttpError(502, `Storage service said ${res.status}${code ? ` ${code}` : ''}: ${msg}${hint}`);
  }
  return res;
}

// ---------------- Azure Blob (container SAS URL) ----------------

function azureParts(cfg) {
  let u;
  try {
    u = new URL(String(cfg.sasUrl || '').trim());
  } catch {
    throw new HttpError(400, 'Paste the container SAS URL, like https://ACCOUNT.blob.core.windows.net/CONTAINER?sv=…&sig=…');
  }
  if (u.protocol !== 'https:' || !u.searchParams.get('sig')) throw new HttpError(400, 'The SAS URL must start with https:// and contain a signature (sig=…).');
  const container = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!container || container.includes('/')) throw new HttpError(400, 'The SAS URL must point to a container, like https://ACCOUNT.blob.core.windows.net/backups?…');
  return { origin: u.origin, container, sas: u.search.slice(1) };
}

const AZURE_VERSION = '2021-08-06'; // allows single uploads up to 5000 MiB

// ---------------- common interface ----------------

function validate(cfg) {
  if (!cfg || !cfg.type || cfg.type === 'none') return null;
  if (cfg.type === 's3') {
    for (const [k, label] of [['bucket', 'Bucket'], ['accessKeyId', 'Access key ID'], ['secretAccessKey', 'Secret access key']]) {
      if (!String(cfg[k] || '').trim()) throw new HttpError(400, `${label} is required for S3 storage`);
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(String(cfg.bucket).trim())) throw new HttpError(400, 'The bucket name looks wrong (lowercase letters, digits, dots and dashes).');
    s3Base(cfg);
  } else if (cfg.type === 'azure') {
    azureParts(cfg);
  } else throw new HttpError(400, 'Unknown storage type');
  return true;
}

function keyFor(cfg, rel) {
  const prefix = cleanPrefix(cfg.prefix);
  return prefix ? `${prefix}/${rel}` : rel;
}

// Signed URL the server can use with curl. method: PUT (upload), GET (download).
function signedUrl(cfg, method, rel, expires = 6 * 3600) {
  const key = keyFor(cfg, rel);
  if (cfg.type === 's3') return { url: s3Presign(cfg, method, key, { expires }), headers: [] };
  const a = azureParts(cfg);
  const url = `${a.origin}/${a.container}/${encPath(key)}?${a.sas}`;
  return { url, headers: method === 'PUT' ? ['x-ms-blob-type: BlockBlob', `x-ms-version: ${AZURE_VERSION}`] : [`x-ms-version: ${AZURE_VERSION}`] };
}

// All objects under a path (relative to the configured prefix): [{ rel, size, modified }].
async function list(cfg, relPrefix = '') {
  const prefix = keyFor(cfg, relPrefix);
  const strip = cleanPrefix(cfg.prefix) ? `${cleanPrefix(cfg.prefix)}/` : '';
  const out = [];
  if (cfg.type === 's3') {
    let token = null;
    for (let page = 0; page < 50; page++) {
      const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const xml = await (await cloudFetch(s3Presign(cfg, 'GET', '', { query, expires: 300 }))).text();
      for (const c of xmlAll(xml, 'Contents')) {
        const key = unxml(xmlOne(c, 'Key'));
        out.push({ rel: key.startsWith(strip) ? key.slice(strip.length) : key, size: Number(xmlOne(c, 'Size')) || 0, modified: xmlOne(c, 'LastModified') });
      }
      if (xmlOne(xml, 'IsTruncated') !== 'true') break;
      token = unxml(xmlOne(xml, 'NextContinuationToken'));
    }
  } else {
    const a = azureParts(cfg);
    let marker = '';
    for (let page = 0; page < 50; page++) {
      const url = `${a.origin}/${a.container}?restype=container&comp=list&prefix=${enc(prefix)}${marker ? `&marker=${enc(marker)}` : ''}&${a.sas}`;
      const xml = await (await cloudFetch(url, { headers: { 'x-ms-version': AZURE_VERSION } })).text();
      for (const b of xmlAll(xml, 'Blob')) {
        const key = unxml(xmlOne(b, 'Name'));
        out.push({ rel: key.startsWith(strip) ? key.slice(strip.length) : key, size: Number(xmlOne(b, 'Content-Length')) || 0, modified: xmlOne(b, 'Last-Modified') });
      }
      marker = unxml(xmlOne(xml, 'NextMarker') || '');
      if (!marker) break;
    }
  }
  return out;
}

async function remove(cfg, rel) {
  if (cfg.type === 's3') await cloudFetch(s3Presign(cfg, 'DELETE', keyFor(cfg, rel), { expires: 300 }), { method: 'DELETE' });
  else {
    const { url, headers } = signedUrl(cfg, 'DELETE', rel, 300);
    await cloudFetch(url, { method: 'DELETE', headers: Object.fromEntries(headers.map((h) => h.split(': '))) });
  }
}

async function putText(cfg, rel, text) {
  const { url, headers } = signedUrl(cfg, 'PUT', rel, 300);
  await cloudFetch(url, { method: 'PUT', body: text, headers: Object.fromEntries(headers.map((h) => h.split(': '))) });
}

async function getText(cfg, rel) {
  const { url, headers } = signedUrl(cfg, 'GET', rel, 300);
  return (await cloudFetch(url, { headers: Object.fromEntries(headers.map((h) => h.split(': '))) })).text();
}

// What people see in the settings ("Backblaze B2 · my-bucket/serverboy").
function describe(cfg) {
  if (!cfg || cfg.type === 'none' || !cfg.type) return 'Only on the server';
  if (cfg.type === 'azure') {
    try {
      const a = azureParts(cfg);
      return `Azure Blob · ${new URL(a.origin).hostname.split('.')[0]}/${a.container}${cleanPrefix(cfg.prefix) ? `/${cleanPrefix(cfg.prefix)}` : ''}`;
    } catch {
      return 'Azure Blob';
    }
  }
  const host = s3Base(cfg).u.hostname;
  const name = /amazonaws/.test(host) ? 'Amazon S3' : /r2\.cloudflarestorage/.test(host) ? 'Cloudflare R2' : /backblazeb2/.test(host) ? 'Backblaze B2' : /wasabisys/.test(host) ? 'Wasabi' : /digitaloceanspaces/.test(host) ? 'DigitalOcean Spaces' : host;
  return `${name} · ${cfg.bucket}${cleanPrefix(cfg.prefix) ? `/${cleanPrefix(cfg.prefix)}` : ''}`;
}

module.exports = { validate, signedUrl, list, remove, putText, getText, describe, s3Presign, cleanPrefix };
