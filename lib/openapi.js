// OpenAPI 3 description of a Data API service (routes/dataapi.js), shown with Swagger UI and
// downloadable as openapi.json for Postman, code generators and AI tools.

const OPS = {
  list: { method: 'get', suffix: '', summary: 'See the list' },
  count: { method: 'get', suffix: '/count', summary: 'Count items' },
  create: { method: 'post', suffix: '', summary: 'Add a new item' },
  get: { method: 'get', suffix: '/{id}', summary: 'See one item' },
  update: { method: 'patch', suffix: '/{id}', summary: 'Change some fields of an item' },
  delete: { method: 'delete', suffix: '/{id}', summary: 'Delete an item' },
};
const PARAM_SCHEMA = {
  string: { type: 'string' },
  number: { type: 'number' },
  boolean: { type: 'boolean' },
  date: { type: 'string', format: 'date-time' },
  objectId: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' },
};

// JSON Schema of a value as mongosh prints it (relaxed Extended JSON).
function schemaOf(v) {
  if (v === null || v === undefined) return {};
  if (Array.isArray(v)) return { type: 'array', items: v.length ? schemaOf(v[0]) : {} };
  if (typeof v === 'object') {
    if (v.$oid) return { type: 'string', pattern: '^[0-9a-fA-F]{24}$', example: v.$oid };
    if (v.$date) return { type: 'string', format: 'date-time', example: typeof v.$date === 'string' ? v.$date : undefined };
    if (v.$numberDecimal || v.$numberLong || v.$numberInt || v.$numberDouble) return { type: 'number' };
    return { type: 'object' };
  }
  if (typeof v === 'number') return { type: 'number', example: v };
  if (typeof v === 'boolean') return { type: 'boolean', example: v };
  return { type: 'string', example: v.length > 60 ? `${v.slice(0, 57)}...` : v };
}

function fieldSchemas(docs, api) {
  const props = {};
  for (const d of docs || []) for (const [k, v] of Object.entries(d)) if (!props[k] || !props[k].type) props[k] = schemaOf(v);
  props._id = props._id || { type: 'string', pattern: '^[0-9a-fA-F]{24}$' };
  for (const f of [...(api.required || []), ...(api.writable || [])]) props[f] = props[f] || { type: 'string' };
  if (api.timestamps) for (const t of ['createdAt', 'updatedAt']) props[t] = props[t] || { type: 'string', format: 'date-time' };
  for (const [k, v] of Object.entries(api.set || {})) props[k] = { ...(props[k] || schemaOf(v)), description: `Always ${JSON.stringify(v)} (set by the API)` };
  const hidden = new Set(api.hidden || []);
  const only = String(api.fields || '').split(',').map((x) => x.trim()).filter(Boolean);
  const shown = Object.fromEntries(Object.entries(props).filter(([k]) => !hidden.has(k) && (!only.length || k === '_id' || only.includes(k))));
  const writable = api.writable || [];
  const readonly = new Set(['_id', ...(api.readonly || []), ...Object.keys(api.set || {}), ...(api.timestamps ? ['createdAt', 'updatedAt'] : [])]);
  const input = Object.fromEntries(Object.entries(props).filter(([k]) => !readonly.has(k) && (!writable.length || writable.includes(k))));
  return { shown, input };
}

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const schemaName = (slug) => slug.replace(/(^|[-_])([a-z0-9])/g, (m, a, b) => b.toUpperCase());

/**
 * build({ info, slugs, samples, serverUrls })
 *   info     the service (name, apis, url, maxLimit, rateLimitPerMinute)
 *   slugs    the APIs to include (default: all)
 *   samples  collection -> sample documents
 *   servers  [{ url, description }]
 */
function build({ info, slugs, samples, servers }) {
  const spec = {
    openapi: '3.0.3',
    info: {
      title: slugs && slugs.length === 1 ? `${info.apis[slugs[0]].title} API` : `${info.name} APIs`,
      version: '1.0.0',
      description: [
        `REST APIs for the MongoDB database **${info.database}**, made with Serverboy.`,
        'Endpoints marked with a lock need an API key in the `x-api-key` header (click **Authorize**). The others are public.',
        'Errors return `{ "error": "message" }`.',
        Number(info.rateLimitPerMinute) ? `Rate limit: ${info.rateLimitPerMinute} requests per minute per visitor / key.` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    servers,
    tags: [],
    paths: {},
    components: {
      securitySchemes: { ApiKey: { type: 'apiKey', in: 'header', name: 'x-api-key', description: 'A key from the API page (🔑 Keys).' } },
      schemas: { Error: { type: 'object', properties: { error: { type: 'string' } } } },
      responses: {
        BadRequest: json(ref('Error'), 'Invalid input'),
        Unauthorized: json(ref('Error'), 'Needs an API key, or the key is invalid'),
        Forbidden: json(ref('Error'), 'The key is not allowed to do this'),
        NotFound: json(ref('Error'), 'Not found (or not shown by this API)'),
        TooMany: json(ref('Error'), 'Too many requests'),
      },
    },
  };
  const max = Number(info.maxLimit) || 100;
  for (const [slug, api] of Object.entries(info.apis || {})) {
    if (slugs && !slugs.includes(slug)) continue;
    const S = schemaName(slug);
    const { shown, input } = fieldSchemas(samples[api.collection], api);
    spec.components.schemas[`${S}Item`] = { type: 'object', properties: shown };
    spec.components.schemas[`${S}Input`] = { type: 'object', properties: input, ...(api.required?.length ? { required: api.required } : {}) };
    spec.components.schemas[`${S}List`] = { type: 'object', properties: { data: { type: 'array', items: ref(`${S}Item`) }, total: { type: 'integer' }, limit: { type: 'integer' }, skip: { type: 'integer' } } };
    const notes = [];
    if (Object.keys(api.filter || {}).length) notes.push(`Only items where \`${JSON.stringify(api.filter)}\`.`);
    if (api.sort) notes.push(`Order: \`${api.sort}\`.`);
    spec.tags.push({ name: api.title, description: [api.description, `Data: ${info.database} → ${api.collection}.`, ...notes].filter(Boolean).join(' ') });
    const linkParams = (api.params || []).map((p) => ({ name: p.name, in: 'query', required: Boolean(p.required), description: [p.description, p.default !== '' ? `Default: ${p.default}` : ''].filter(Boolean).join('. '), schema: PARAM_SCHEMA[p.type] || { type: 'string' } }));
    const idParam = { name: 'id', in: 'path', required: true, description: 'The item _id', schema: { type: 'string' } };
    const pageSize = Math.min(Number(api.limit) || max, max);
    for (const [op, o] of Object.entries(OPS)) {
      const mode = api.ops?.[op] || 'off';
      if (mode === 'off') continue;
      const path = `/api/${slug}${o.suffix}`;
      const parameters = [...(o.suffix === '/{id}' ? [idParam] : []), ...linkParams];
      if (op === 'list') {
        parameters.push(
          { name: 'limit', in: 'query', description: `Items per page (max ${pageSize})`, schema: { type: 'integer', minimum: 1, maximum: pageSize, default: Math.min(20, pageSize) } },
          { name: 'page', in: 'query', description: 'Page number, starting at 1', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'fields', in: 'query', description: 'Comma-separated fields to return', schema: { type: 'string' } },
        );
        if (api.callerSort !== false) parameters.push({ name: 'sort', in: 'query', description: 'Fields, - for descending, e.g. -createdAt', schema: { type: 'string' } });
      }
      if ((op === 'list' || op === 'count') && api.callerFilters !== false) {
        parameters.push({ name: 'filter', in: 'query', description: 'MongoDB filter as JSON, e.g. {"price":{"$gte":20}}. You can also add field=value pairs, e.g. ?status=active', schema: { type: 'string' } });
      }
      const responses = {
        list: { 200: json(ref(`${S}List`)) },
        count: { 200: json({ type: 'object', properties: { count: { type: 'integer' } } }) },
        get: { 200: json(ref(`${S}Item`)), 404: { $ref: '#/components/responses/NotFound' } },
        create: { 201: json(ref(`${S}Item`), 'Created'), 400: { $ref: '#/components/responses/BadRequest' } },
        update: { 200: json(ref(`${S}Item`)), 400: { $ref: '#/components/responses/BadRequest' }, 404: { $ref: '#/components/responses/NotFound' } },
        delete: { 200: json({ type: 'object', properties: { deleted: { type: 'boolean' } } }), 404: { $ref: '#/components/responses/NotFound' } },
      }[op];
      if (mode === 'key') Object.assign(responses, { 401: { $ref: '#/components/responses/Unauthorized' }, 403: { $ref: '#/components/responses/Forbidden' } });
      if (Number(info.rateLimitPerMinute)) responses[429] = { $ref: '#/components/responses/TooMany' };
      const operation = {
        tags: [api.title],
        summary: o.summary,
        description: mode === 'key' ? 'Needs an API key.' : 'Public: no key needed.',
        operationId: `${op}${S}`,
        parameters,
        responses,
        security: mode === 'key' ? [{ ApiKey: [] }] : [],
      };
      if (op === 'create' || op === 'update') operation.requestBody = { required: true, content: { 'application/json': { schema: ref(`${S}Input`) } } };
      spec.paths[path] = spec.paths[path] || {};
      spec.paths[path][o.method] = operation;
      if (op === 'update') spec.paths[path].put = { ...operation, summary: 'Replace a whole item', operationId: `replace${S}` };
    }
  }
  return spec;
}

module.exports = { build };
