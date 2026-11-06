'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const remote = require('../../lib/backup-remote');

const AWS_EXAMPLE = { bucket: 'examplebucket', region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

test('S3 presigned URL matches the AWS reference example', () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  const url = remote.s3Presign(AWS_EXAMPLE, 'GET', 'test.txt', { expires: 86400, now: new Date('2013-05-24T00:00:00Z') });
  assert.ok(url.startsWith('https://examplebucket.s3.amazonaws.com/test.txt?'));
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test('custom endpoints (R2, B2, MinIO) use path-style addresses', () => {
  const url = remote.s3Presign({ ...AWS_EXAMPLE, endpoint: 'https://acct.r2.cloudflarestorage.com', region: 'auto', bucket: 'backups' }, 'PUT', 'a b/c.gz');
  const u = new URL(url);
  assert.equal(u.host, 'acct.r2.cloudflarestorage.com');
  assert.equal(u.pathname, '/backups/a%20b/c.gz');
  assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'host');
});

test('validate rejects incomplete or wrong settings', () => {
  assert.equal(remote.validate({ type: 'none' }), null);
  assert.throws(() => remote.validate({ type: 's3', bucket: 'b', accessKeyId: 'x' }), /Secret access key/);
  assert.throws(() => remote.validate({ type: 's3', bucket: 'Bad_Bucket', accessKeyId: 'x', secretAccessKey: 'y' }), /bucket name/);
  assert.throws(() => remote.validate({ type: 'azure', sasUrl: 'not a url' }), /SAS URL/);
  assert.throws(() => remote.validate({ type: 'azure', sasUrl: 'https://a.blob.core.windows.net/c?sv=1' }), /signature/);
  assert.throws(() => remote.validate({ type: 'ftp' }), /Unknown storage/);
  assert.equal(remote.validate({ type: 'azure', sasUrl: 'https://acct.blob.core.windows.net/backups?sv=2022&sig=abc' }), true);
});

test('Azure signed URLs add the blob path and keep the SAS token', () => {
  const { url, headers } = remote.signedUrl({ type: 'azure', sasUrl: 'https://acct.blob.core.windows.net/backups?sv=2022&sig=abc', prefix: '/sb/' }, 'PUT', 'srv/1/x.gz');
  assert.equal(url, 'https://acct.blob.core.windows.net/backups/sb/srv/1/x.gz?sv=2022&sig=abc');
  assert.ok(headers.includes('x-ms-blob-type: BlockBlob'));
});

test('describe names the provider without secrets', () => {
  assert.equal(remote.describe({ type: 's3', endpoint: 'https://s3.eu-central-003.backblazeb2.com', bucket: 'b', secretAccessKey: 'SECRET' }), 'Backblaze B2 · b');
  assert.equal(remote.describe({ type: 's3', bucket: 'b', prefix: 'x/' }), 'Amazon S3 · b/x');
  assert.equal(remote.describe({ type: 'none' }), 'Only on the server');
  assert.doesNotMatch(remote.describe({ type: 'azure', sasUrl: 'https://acct.blob.core.windows.net/c?sv=1&sig=SECRET' }), /SECRET/);
});

test('cleanPrefix trims slashes', () => {
  assert.equal(remote.cleanPrefix('//a//b/'), 'a/b');
  assert.equal(remote.cleanPrefix(undefined), '');
});
