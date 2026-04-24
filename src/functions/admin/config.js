const { app } = require('@azure/functions');
const { getPool, sql } = require('../../lib/db');
const { getAllConfig, invalidateConfigCache } = require('../../lib/config-cache');
const { requireAdminKey, corsHeaders } = require('./middleware');

// GET /admin/config — returns all system_config key-value pairs
app.http('adminConfigGet', {
  methods: ['GET', 'OPTIONS'],
  route: 'mgmt/config',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders() };
    }
    const authError = requireAdminKey(request);
    if (authError) return authError;

    const config = await getAllConfig();

    // Redact empty values but keep keys visible so the UI knows what to fill in
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify(config),
    };
  },
});

// PUT /admin/config/{key} — update a single config value
app.http('adminConfigUpdate', {
  methods: ['PUT', 'OPTIONS'],
  route: 'mgmt/config/{key}',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders() };
    }
    const authError = requireAdminKey(request);
    if (authError) return authError;

    const key = request.params.key;
    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, body: JSON.stringify({ error: 'invalid json' }) };
    }

    if (body.value === undefined || body.value === null) {
      return { status: 400, body: JSON.stringify({ error: 'value is required' }) };
    }

    const pool = await getPool();

    // Upsert — update if exists, insert if new key
    await pool
      .request()
      .input('key', sql.NVarChar(255), key)
      .input('value', sql.NVarChar(sql.MAX), String(body.value))
      .query(`
        MERGE system_config AS target
        USING (SELECT @key AS [key], @value AS value) AS source
          ON target.[key] = source.[key]
        WHEN MATCHED THEN
          UPDATE SET value = source.value, updated_at = SYSDATETIMEOFFSET()
        WHEN NOT MATCHED THEN
          INSERT ([key], value) VALUES (source.[key], source.value);
      `);

    invalidateConfigCache();

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify({ key, updated: true }),
    };
  },
});
