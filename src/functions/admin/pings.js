const { app } = require('@azure/functions');
const { getPool, sql } = require('../../lib/db');
const { requireAdminKey, corsHeaders } = require('./middleware');

// GET /admin/pings
// Query params: campaign, publisher_id, won (true/false), since (ISO timestamp),
//               date_from, date_to, limit (default 100, max 500)
app.http('adminPings', {
  methods: ['GET', 'OPTIONS'],
  route: 'mgmt/pings',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders() };
    }
    const authError = requireAdminKey(request);
    if (authError) return authError;

    const params = request.query;
    const campaign = params.get('campaign');
    const publisherId = params.get('publisher_id');
    const wonFilter = params.get('won'); // 'true' | 'false' | null
    const since = params.get('since');   // ISO string — for polling new pings
    const dateFrom = params.get('date_from');
    const dateTo = params.get('date_to');
    const limit = Math.min(parseInt(params.get('limit') || '100', 10), 500);

    const pool = await getPool();
    const req = pool.request();

    let where = 'WHERE 1=1';

    if (campaign) {
      where += ' AND p.campaign = @campaign';
      req.input('campaign', sql.NVarChar(255), campaign);
    }
    if (publisherId) {
      where += ' AND p.publisher_id = @publisher_id';
      req.input('publisher_id', sql.NVarChar(255), publisherId);
    }
    if (wonFilter === 'true') {
      where += ' AND r.won = 1';
    } else if (wonFilter === 'false') {
      where += ' AND (r.won = 0 OR r.won IS NULL)';
    }
    if (since) {
      where += ' AND p.created_at > @since';
      req.input('since', sql.DateTimeOffset, new Date(since));
    }
    if (dateFrom) {
      where += ' AND p.created_at >= @date_from';
      req.input('date_from', sql.DateTimeOffset, new Date(dateFrom));
    }
    if (dateTo) {
      where += ' AND p.created_at <= @date_to';
      req.input('date_to', sql.DateTimeOffset, new Date(dateTo));
    }

    req.input('limit', sql.Int, limit);

    const result = await req.query(`
      SELECT TOP (@limit)
        p.id,
        p.created_at,
        RIGHT(p.phone, 4)        AS phone_last4,
        p.publisher_id,
        p.campaign,
        p.zip,
        p.zip_source,
        p.ip,
        p.is_duplicate,
        p.subid,
        p.raw_payload,
        r.bid_amount,
        r.buyer_id,
        r.routing_number,
        r.won,
        r.call_forwarded,
        r.call_forwarded_at,
        r.response_time_ms,
        r.raw_response,
        r.outbound_payload,
        r.ringba_status,
        r.ringba_status_code,
        COALESCE(r.ringba_status, 'pending') AS status
      FROM inbound_pings p
      LEFT JOIN ringba_responses r ON r.ping_id = p.id
      ${where}
      ORDER BY p.created_at DESC
    `);

    const rows = result.recordset.map(r => {
      const inbound  = tryParse(r.raw_payload);
      const outbound = tryParse(r.outbound_payload);
      const response = tryParse(r.raw_response);

      return {
        ...r,
        // ① IN — what publisher sent to Billy
        raw_payload: inbound,
        // ② OUT — what Billy sent to Ringba (normalized to snake_case for UI)
        outbound_payload: outbound ? {
          cid:              outbound.CID             ?? outbound.cid             ?? null,
          zipcode:          outbound.zipcode         ?? outbound.zip             ?? null,
          expose_caller_id: outbound.exposeCallerId  ?? outbound.expose_caller_id ?? null,
          source:           outbound.source          ?? null,
        } : null,
        // ③ OUT Response — what Ringba sent back
        raw_response: response,
        // Convenience flag for UI "no data" checks
        has_outbound:  outbound  != null,
        has_response:  response  != null,
        has_postback:  r.call_forwarded === true,
      };
    });

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify(rows),
    };
  },
});

function tryParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return str; }
}

// POST /mgmt/pings/{id}/replay
// Re-fires the original raw_payload for a logged ping back through the Billy
// ping handler. If the campaign field looks like a Ringba RTB ID (32-char hex),
// replays via /api/ping/{rtbId}. Otherwise uses /api/ping with the stored fields.
app.http('adminPingReplay', {
  methods: ['POST', 'OPTIONS'],
  route: 'mgmt/pings/{id}/replay',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') {
      return { status: 204, headers: corsHeaders() };
    }
    const authError = requireAdminKey(request);
    if (authError) return authError;

    const { id } = request.params;
    const pool = await getPool();

    const result = await pool.request()
      .input('id', sql.UniqueIdentifier, id)
      .query(`
        SELECT TOP 1 p.raw_payload, p.phone, p.zip, p.publisher_id, p.subid, p.campaign, p.ip
        FROM inbound_pings p WHERE p.id = @id
      `);

    if (!result.recordset.length) {
      return { status: 404, headers: corsHeaders(), body: JSON.stringify({ error: 'ping not found' }) };
    }

    const ping = result.recordset[0];
    const rawPayload = ping.raw_payload ? JSON.parse(ping.raw_payload) : null;

    // Determine replay URL — campaign field stores rtbId when pinged via /ping/{rtbId}
    const isRtbId = /^[0-9a-f]{32}$/i.test(ping.campaign);
    const baseUrl = process.env.SELF_BASE_URL || 'https://func-billy-prepng.azurewebsites.net/api';
    const replayUrl = isRtbId
      ? `${baseUrl}/ping/${ping.campaign}`
      : `${baseUrl}/ping`;

    // Build replay body: prefer original raw_payload, fallback to stored fields
    const replayBody = rawPayload ?? {
      phone: ping.phone,
      zip: ping.zip,
      publisher_id: ping.publisher_id,
      subid: ping.subid,
      campaign: ping.campaign,
      ip: ping.ip,
    };

    const replayRes = await fetch(replayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(replayBody),
    });

    const replayResponse = await replayRes.json();

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify({
        replayed_to: replayUrl,
        original_payload: replayBody,
        response: replayResponse,
      }),
    };
  },
});
