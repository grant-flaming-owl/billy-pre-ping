const { app } = require('@azure/functions');
const { getPool } = require('../../lib/db');
const { requireAdminKey, corsHeaders } = require('./middleware');

// GET /mgmt/stats
// Returns speed and performance data for the Lovable dashboard.
// Query params: period (today | 7d | 30d | all), campaign, publisher_id
app.http('adminStats', {
  methods: ['GET', 'OPTIONS'],
  route: 'mgmt/stats',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    if (request.method === 'OPTIONS') return { status: 204, headers: corsHeaders() };
    const authError = requireAdminKey(request);
    if (authError) return authError;

    const params = request.query;
    const period      = params.get('period') ?? '7d';
    const campaign    = params.get('campaign');
    const publisherId = params.get('publisher_id');

    const pool = await getPool();
    const req  = pool.request();

    // Period filter
    const periodMap = { today: 1, '7d': 7, '30d': 30, all: null };
    const days = periodMap[period] ?? 7;
    let timeFilter = '';
    if (days) {
      timeFilter = `AND p.created_at >= DATEADD(day, -${days}, SYSDATETIMEOFFSET())`;
    }

    let extraFilter = '';
    if (campaign) {
      extraFilter += ' AND p.campaign = @campaign';
      req.input('campaign', require('mssql').NVarChar(255), campaign);
    }
    if (publisherId) {
      extraFilter += ' AND p.publisher_id = @publisher_id';
      req.input('publisher_id', require('mssql').NVarChar(255), publisherId);
    }

    const where = `WHERE 1=1 ${timeFilter} ${extraFilter}`;

    // ── Overall summary ───────────────────────────────────────────────────────
    const summary = await req.query(`
      SELECT
        COUNT(p.id)                                          AS total_pings,
        SUM(CASE WHEN p.is_duplicate = 1 THEN 1 ELSE 0 END) AS total_duplicates,
        SUM(CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END)   AS total_with_response,
        SUM(CASE WHEN r.bid_amount IS NOT NULL THEN 1 ELSE 0 END) AS total_bids,
        SUM(CASE WHEN r.won = 1 THEN 1 ELSE 0 END)          AS total_won,
        AVG(CAST(r.response_time_ms AS FLOAT))               AS avg_response_ms,
        MIN(r.response_time_ms)                              AS min_response_ms,
        MAX(r.response_time_ms)                              AS max_response_ms,
        AVG(CAST(r.bid_amount AS FLOAT))                     AS avg_bid_amount,
        MAX(r.bid_amount)                                    AS max_bid_amount
      FROM inbound_pings p
      LEFT JOIN ringba_responses r ON r.ping_id = p.id
      ${where}
    `);

    const s = summary.recordset[0];
    const totalPings = s.total_pings || 0;
    const totalBids  = s.total_bids  || 0;
    const totalWon   = s.total_won   || 0;

    // ── Hourly volume (last 24h) ──────────────────────────────────────────────
    const req2 = pool.request();
    if (campaign)    req2.input('campaign',    require('mssql').NVarChar(255), campaign);
    if (publisherId) req2.input('publisher_id', require('mssql').NVarChar(255), publisherId);

    const hourly = await req2.query(`
      SELECT
        DATEPART(hour, p.created_at)  AS hour,
        CONVERT(DATE, p.created_at)   AS day,
        COUNT(p.id)                   AS pings,
        SUM(CASE WHEN r.bid_amount IS NOT NULL THEN 1 ELSE 0 END) AS bids,
        AVG(CAST(r.response_time_ms AS FLOAT)) AS avg_ms
      FROM inbound_pings p
      LEFT JOIN ringba_responses r ON r.ping_id = p.id
      WHERE p.created_at >= DATEADD(hour, -24, SYSDATETIMEOFFSET())
      ${extraFilter}
      GROUP BY DATEPART(hour, p.created_at), CONVERT(DATE, p.created_at)
      ORDER BY day, hour
    `);

    // ── Per-campaign breakdown ────────────────────────────────────────────────
    const req3 = pool.request();
    if (days) req3.input('days', require('mssql').Int, days);
    if (publisherId) req3.input('publisher_id', require('mssql').NVarChar(255), publisherId);

    const byCampaign = await req3.query(`
      SELECT
        p.campaign,
        COUNT(p.id)                                                AS total_pings,
        SUM(CASE WHEN r.bid_amount IS NOT NULL THEN 1 ELSE 0 END) AS bids,
        SUM(CASE WHEN r.won = 1 THEN 1 ELSE 0 END)                AS won,
        AVG(CAST(r.response_time_ms AS FLOAT))                     AS avg_response_ms,
        AVG(CAST(r.bid_amount AS FLOAT))                           AS avg_bid_amount,
        MAX(p.created_at)                                          AS last_ping_at
      FROM inbound_pings p
      LEFT JOIN ringba_responses r ON r.ping_id = p.id
      WHERE 1=1
        ${days ? `AND p.created_at >= DATEADD(day, -${days}, SYSDATETIMEOFFSET())` : ''}
        ${publisherId ? 'AND p.publisher_id = @publisher_id' : ''}
      GROUP BY p.campaign
      ORDER BY total_pings DESC
    `);

    // ── Response time buckets (speed distribution) ────────────────────────────
    const req4 = pool.request();
    const buckets = await req4.query(`
      SELECT
        SUM(CASE WHEN r.response_time_ms < 10  THEN 1 ELSE 0 END) AS under_10ms,
        SUM(CASE WHEN r.response_time_ms BETWEEN 10 AND 24  THEN 1 ELSE 0 END) AS ms_10_24,
        SUM(CASE WHEN r.response_time_ms BETWEEN 25 AND 44  THEN 1 ELSE 0 END) AS ms_25_44,
        SUM(CASE WHEN r.response_time_ms >= 45 THEN 1 ELSE 0 END)  AS ms_45_plus
      FROM ringba_responses r
      INNER JOIN inbound_pings p ON p.id = r.ping_id
      WHERE r.response_time_ms IS NOT NULL
        ${days ? `AND p.created_at >= DATEADD(day, -${days}, SYSDATETIMEOFFSET())` : ''}
    `);

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders() },
      body: JSON.stringify({
        period,
        summary: {
          total_pings:      totalPings,
          total_duplicates: s.total_duplicates || 0,
          total_bids:       totalBids,
          total_won:        totalWon,
          bid_rate:         totalPings > 0 ? +(totalBids / totalPings * 100).toFixed(1) : 0,
          win_rate:         totalBids  > 0 ? +(totalWon  / totalBids  * 100).toFixed(1) : 0,
          duplicate_rate:   totalPings > 0 ? +((s.total_duplicates || 0) / totalPings * 100).toFixed(1) : 0,
          avg_response_ms:  s.avg_response_ms  ? +s.avg_response_ms.toFixed(1)  : null,
          min_response_ms:  s.min_response_ms  ?? null,
          max_response_ms:  s.max_response_ms  ?? null,
          avg_bid_amount:   s.avg_bid_amount   ? +s.avg_bid_amount.toFixed(4)   : null,
          max_bid_amount:   s.max_bid_amount   ?? null,
        },
        speed_buckets:  buckets.recordset[0],
        hourly_volume:  hourly.recordset,
        by_campaign:    byCampaign.recordset.map(r => ({
          ...r,
          bid_rate: r.total_pings > 0 ? +(r.bids / r.total_pings * 100).toFixed(1) : 0,
          win_rate: r.bids > 0        ? +(r.won  / r.bids         * 100).toFixed(1) : 0,
        })),
      }),
    };
  },
});
