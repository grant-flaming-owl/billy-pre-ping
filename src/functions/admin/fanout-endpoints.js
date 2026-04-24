const { app } = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');
const { getPool, sql } = require('../../lib/db');
const { invalidateFanoutCache } = require('../../lib/config-cache');
const { requireAdminKey, corsHeaders } = require('./middleware');

// GET /admin/fanout-endpoints
app.http('adminFanoutList', {
  methods: ['GET', 'OPTIONS'],
  route: 'mgmt/fanout-endpoints',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders() };
    }
    const authError = requireAdminKey(request);
    if (authError) return authError;

    const pool = await getPool();
    const result = await pool
      .request()
      .query('SELECT * FROM fanout_endpoints ORDER BY created_at DESC');

    const rows = result.recordset.map((row) => ({
      ...row,
      rules: row.rules ? JSON.parse(row.rules) : {},
    }));

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify(rows),
    };
  },
});

// POST /admin/fanout-endpoints
app.http('adminFanoutCreate', {
  methods: ['POST'],
  route: 'mgmt/fanout-endpoints',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const authError = requireAdminKey(request);
    if (authError) return authError;

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, body: JSON.stringify({ error: 'invalid json' }) };
    }

    const { name, url, method = 'POST', enabled = true, rules = {} } = body;
    if (!name || !url) {
      return { status: 400, body: JSON.stringify({ error: 'name and url are required' }) };
    }
    if (!['POST', 'GET'].includes(method)) {
      return { status: 400, body: JSON.stringify({ error: 'method must be POST or GET' }) };
    }

    const id = uuidv4();
    const pool = await getPool();
    await pool
      .request()
      .input('id', sql.UniqueIdentifier, id)
      .input('name', sql.NVarChar(255), name)
      .input('url', sql.NVarChar(2048), url)
      .input('method', sql.NVarChar(10), method)
      .input('enabled', sql.Bit, enabled ? 1 : 0)
      .input('rules', sql.NVarChar(sql.MAX), JSON.stringify(rules))
      .query(`
        INSERT INTO fanout_endpoints (id, name, url, method, enabled, rules)
        VALUES (@id, @name, @url, @method, @enabled, @rules)
      `);

    invalidateFanoutCache();

    return {
      status: 201,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify({ id, name, url, method, enabled, rules }),
    };
  },
});

// PUT /admin/fanout-endpoints/{id}
app.http('adminFanoutUpdate', {
  methods: ['PUT', 'OPTIONS'],
  route: 'mgmt/fanout-endpoints/{id}',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders() };
    }
    const authError = requireAdminKey(request);
    if (authError) return authError;

    const endpointId = request.params.id;
    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, body: JSON.stringify({ error: 'invalid json' }) };
    }

    const { name, url, method, enabled, rules } = body;
    if (method && !['POST', 'GET'].includes(method)) {
      return { status: 400, body: JSON.stringify({ error: 'method must be POST or GET' }) };
    }

    const pool = await getPool();
    const existing = await pool
      .request()
      .input('id', sql.UniqueIdentifier, endpointId)
      .query('SELECT * FROM fanout_endpoints WHERE id = @id');

    if (existing.recordset.length === 0) {
      return { status: 404, body: JSON.stringify({ error: 'endpoint not found' }) };
    }

    const current = existing.recordset[0];
    await pool
      .request()
      .input('id', sql.UniqueIdentifier, endpointId)
      .input('name', sql.NVarChar(255), name ?? current.name)
      .input('url', sql.NVarChar(2048), url ?? current.url)
      .input('method', sql.NVarChar(10), method ?? current.method)
      .input('enabled', sql.Bit, enabled !== undefined ? (enabled ? 1 : 0) : current.enabled)
      .input('rules', sql.NVarChar(sql.MAX), rules !== undefined ? JSON.stringify(rules) : current.rules)
      .query(`
        UPDATE fanout_endpoints
        SET name = @name, url = @url, method = @method, enabled = @enabled, rules = @rules
        WHERE id = @id
      `);

    invalidateFanoutCache();

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify({ id: endpointId, updated: true }),
    };
  },
});

// DELETE /admin/fanout-endpoints/{id}
app.http('adminFanoutDelete', {
  methods: ['DELETE'],
  route: 'mgmt/fanout-endpoints/{id}',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const authError = requireAdminKey(request);
    if (authError) return authError;

    const endpointId = request.params.id;
    const pool = await getPool();
    const result = await pool
      .request()
      .input('id', sql.UniqueIdentifier, endpointId)
      .query('DELETE FROM fanout_endpoints WHERE id = @id');

    if (result.rowsAffected[0] === 0) {
      return { status: 404, body: JSON.stringify({ error: 'endpoint not found' }) };
    }

    invalidateFanoutCache();

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify({ deleted: true }),
    };
  },
});
