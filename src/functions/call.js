const { app } = require('@azure/functions');
const { getPool, sql } = require('../lib/db');
const { forwardCallToRingba } = require('../lib/ringba');
const { getConfig } = require('../lib/config-cache');

app.http('call', {
  methods: ['POST'],
  route: 'call',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, body: JSON.stringify({ error: 'invalid json' }) };
    }

    const { ping_id, phone, publisher_id } = body;

    if (!ping_id || !phone || !publisher_id) {
      return {
        status: 400,
        body: JSON.stringify({ error: 'ping_id, phone, and publisher_id are required' }),
      };
    }

    // ── Look up original ping + Ringba routing number ─────────────────────────
    const pool = await getPool();

    const result = await pool
      .request()
      .input('ping_id', sql.UniqueIdentifier, ping_id)
      .input('publisher_id', sql.NVarChar(255), publisher_id)
      .query(`
        SELECT
          p.id             AS ping_id,
          p.publisher_id,
          r.id             AS response_id,
          r.routing_number,
          r.won,
          r.call_forwarded
        FROM inbound_pings p
        LEFT JOIN ringba_responses r ON r.ping_id = p.id
        WHERE p.id = @ping_id
          AND p.publisher_id = @publisher_id
      `);

    if (result.recordset.length === 0) {
      console.error(`[call] ping_id not found: ${ping_id}`);
      return { status: 404, body: JSON.stringify({ error: 'ping_id not found' }) };
    }

    const row = result.recordset[0];

    // ── Forward call to Ringba ────────────────────────────────────────────────
    const callUrl = await getConfig('ringba_call_url');
    const callPayload = {
      ping_id,
      phone,
      publisher_id,
      routing_number: row.routing_number,
    };

    const ringbaResponse = await forwardCallToRingba(callPayload, callUrl);

    // ── Mark call as forwarded (fire and forget) ──────────────────────────────
    if (row.response_id) {
      markCallForwarded(pool, row.response_id).catch((err) =>
        console.error('[call] db update failed:', err.message)
      );
    }

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ringbaResponse ?? { forwarded: true }),
    };
  },
});

async function markCallForwarded(pool, responseId) {
  await pool
    .request()
    .input('id', sql.UniqueIdentifier, responseId)
    .query(`
      UPDATE ringba_responses
      SET call_forwarded = 1, call_forwarded_at = SYSDATETIMEOFFSET()
      WHERE id = @id
    `);
}
