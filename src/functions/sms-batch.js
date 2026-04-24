/**
 * SMS batch processor — fires CampaignKit for all eligible RTB pings.
 *
 * Eligibility rules:
 *   1. inbound_pings.campaign maps to category_mappings (enabled = 1)
 *   2. phone NOT in contact_history within suppression window
 *   3. Deduplicated by phone — most recent ping per phone wins
 *
 * Endpoints:
 *   GET  /mgmt/sms/batch/preview   — dry-run: see who would be messaged
 *   POST /mgmt/sms/batch           — execute batch (body: { limit, dry_run })
 *   POST /mgmt/sms/trigger         — fire SMS for a single ping_id
 *
 * Timer trigger: every 15 min (0 *\/15 * * * *)
 */
const { app } = require('@azure/functions');
const { getPool, sql } = require('../lib/db');
const { getConfig } = require('../lib/config-cache');
const { requireAdminKey, corsHeaders } = require('./admin/middleware');
const { v4: uuidv4 } = require('uuid');

// ── Core batch query — returns eligible pings ─────────────────────────────────

async function getEligiblePings(pool, { suppressionDays, limit }) {
  const cutoff = new Date(Date.now() - suppressionDays * 86_400_000);

  // One row per phone — latest ping for that phone that has a category mapping
  // and hasn't been SMS'd within the suppression window.
  const r = await pool.request()
    .input('cutoff', sql.DateTimeOffset, cutoff)
    .input('limit',  sql.Int,            limit)
    .query(`
      SELECT TOP (@limit)
        ip.id        AS ping_id,
        ip.phone,
        ip.campaign,
        ip.vertical,
        ip.created_at,
        cm.category_key,
        cm.campaignkit_id
      FROM inbound_pings ip
      JOIN category_mappings cm
        ON cm.campaign = ip.campaign AND cm.enabled = 1
      WHERE
        -- Latest ping per phone (avoid double-sending)
        ip.id = (
          SELECT TOP 1 id FROM inbound_pings ip2
          WHERE ip2.phone = ip.phone
          ORDER BY ip2.created_at DESC
        )
        -- Not already sent within suppression window
        AND NOT EXISTS (
          SELECT 1 FROM contact_history ch
          WHERE ch.phone = ip.phone
            AND ch.contact_type = 'sms'
            AND ch.contacted_at >= @cutoff
        )
      ORDER BY ip.created_at ASC
    `);

  return r.recordset;
}

// ── CampaignKit fire + logging ────────────────────────────────────────────────

async function fireSmsForPing(pool, row, { triggerUrl, apiKey, listId }) {
  const formattedPhone = row.phone.startsWith('1') ? row.phone : `1${row.phone}`;

  let statusCode = null, latencyMs = 0, response = null, success = false;

  if (triggerUrl) {
    const start = Date.now();
    try {
      const res = await fetch(triggerUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body:    JSON.stringify({ list_id: listId, phone: formattedPhone, source_url: row.category_key }),
      });
      latencyMs  = Date.now() - start;
      statusCode = res.status;
      try { response = await res.json(); } catch { /* ok */ }
      success = res.ok;
    } catch (err) {
      latencyMs = Date.now() - start;
      response  = { error: err.message };
    }
  }

  // Write contact_history to suppress future sends
  if (success) {
    await pool.request()
      .input('id',      sql.UniqueIdentifier, uuidv4())
      .input('phone',   sql.NVarChar(20),     row.phone)
      .input('type',    sql.NVarChar(20),     'sms')
      .input('channel', sql.NVarChar(50),     'campaignkit')
      .input('ping_id', sql.UniqueIdentifier, row.ping_id)
      .input('mts_id',  sql.UniqueIdentifier, null)
      .input('campaign',sql.NVarChar(255),    row.campaign)
      .input('vertical',sql.NVarChar(50),     row.vertical ?? null)
      .query(`
        INSERT INTO contact_history
          (id, phone, contact_type, channel, ping_id, mts_id, campaign, vertical)
        VALUES
          (@id, @phone, @type, @channel, @ping_id, @mts_id, @campaign, @vertical)
      `);
  }

  // Always log to sequence_triggers (success or failure)
  await pool.request()
    .input('id',       sql.UniqueIdentifier,  uuidv4())
    .input('mts_id',   sql.UniqueIdentifier,  null)
    .input('ping_id',  sql.UniqueIdentifier,  row.ping_id)
    .input('phone',    sql.NVarChar(20),       row.phone)
    .input('vertical', sql.NVarChar(50),       row.vertical ?? null)
    .input('campaign', sql.NVarChar(255),      row.campaign)
    .input('flow',     sql.NVarChar(10),       'sms')
    .input('action',   sql.NVarChar(50),       success ? 'campaignkit_trigger' : 'campaignkit_error')
    .input('contacted',sql.Bit,                0)
    .input('incat',    sql.Bit,                1)
    .input('cat',      sql.NVarChar(255),      row.category_key)
    .input('ext_code', sql.Int,                statusCode)
    .input('ext_resp', sql.NVarChar(sql.MAX),  response ? JSON.stringify(response) : null)
    .input('ext_ms',   sql.Int,                latencyMs)
    .query(`
      INSERT INTO sequence_triggers
        (id, mts_id, ping_id, phone, vertical, campaign, flow, action,
         was_contacted_30d, was_in_category, category_matched,
         external_status_code, external_response, external_latency_ms)
      VALUES
        (@id, @mts_id, @ping_id, @phone, @vertical, @campaign, @flow, @action,
         @contacted, @incat, @cat, @ext_code, @ext_resp, @ext_ms)
    `);

  return { phone: row.phone, campaign: row.campaign, category_key: row.category_key, status_code: statusCode, success, latency_ms: latencyMs };
}

// ── Shared batch runner ───────────────────────────────────────────────────────

async function runBatch(pool, { suppressionDays, limit, dryRun }) {
  const candidates = await getEligiblePings(pool, { suppressionDays, limit });

  if (dryRun) {
    return {
      dry_run:    true,
      eligible:   candidates.length,
      candidates: candidates.map(r => ({
        ping_id:      r.ping_id,
        phone:        r.phone,
        campaign:     r.campaign,
        category_key: r.category_key,
        pinged_at:    r.created_at,
      })),
    };
  }

  const triggerUrl  = await getConfig('campaignkit_trigger_url');
  const apiKey      = await getConfig('campaignkit_api_key');
  const listId      = parseInt(await getConfig('campaignkit_list_id') ?? '92', 10);
  // Delay between CampaignKit calls — prevents hitting API rate limits mid-batch.
  // Configurable via system_config key 'campaignkit_batch_delay_ms' (default 75ms).
  const delayMs     = parseInt(await getConfig('campaignkit_batch_delay_ms') ?? '75', 10);

  const results = [];
  for (const row of candidates) {
    const result = await fireSmsForPing(pool, row, { triggerUrl, apiKey, listId });
    results.push(result);
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
  }

  const sent   = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  return { processed: results.length, sent, failed, results };
}

// ── Timer trigger — every 15 minutes ─────────────────────────────────────────

app.timer('smsBatchTimer', {
  schedule: '0 */15 * * * *',
  runOnStartup: false,
  handler: async (myTimer, context) => {
    const pool            = await getPool();
    const suppressionDays = parseInt(await getConfig('sms_suppression_window_days') ?? '30', 10);
    const result          = await runBatch(pool, { suppressionDays, limit: 500, dryRun: false });
    context.log(`[sms-batch] timer: ${result.sent} sent, ${result.failed} failed of ${result.processed} processed`);
  },
});

// ── GET /mgmt/sms/batch/preview — dry-run preview ────────────────────────────

app.http('smsBatchPreview', {
  methods: ['GET', 'OPTIONS'],
  route: 'mgmt/sms/batch/preview',
  authLevel: 'anonymous',
  handler: async (req) => {
    if (req.method === 'OPTIONS') return { status: 204, headers: corsHeaders() };
    const authError = requireAdminKey(req);
    if (authError) return authError;

    const limit           = Math.min(parseInt(req.query.get('limit') ?? '200'), 2000);
    const pool            = await getPool();
    const suppressionDays = parseInt(await getConfig('sms_suppression_window_days') ?? '30', 10);
    const result          = await runBatch(pool, { suppressionDays, limit, dryRun: true });

    return { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() }, body: JSON.stringify(result) };
  },
});

// ── POST /mgmt/sms/batch — execute batch ─────────────────────────────────────

app.http('smsBatchExecute', {
  methods: ['POST', 'OPTIONS'],
  route: 'mgmt/sms/batch',
  authLevel: 'anonymous',
  handler: async (req) => {
    if (req.method === 'OPTIONS') return { status: 204, headers: corsHeaders() };
    const authError = requireAdminKey(req);
    if (authError) return authError;

    let body = {};
    try { body = await req.json(); } catch { /* no body = use defaults */ }

    const dryRun          = body.dry_run  ?? false;
    const limit           = Math.min(body.limit ?? 500, 2000);
    const pool            = await getPool();
    const suppressionDays = parseInt(await getConfig('sms_suppression_window_days') ?? '30', 10);
    const result          = await runBatch(pool, { suppressionDays, limit, dryRun });

    return { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() }, body: JSON.stringify(result) };
  },
});

// ── POST /mgmt/sms/trigger — single-ping manual fire ─────────────────────────
// Body: { ping_id } OR { phone, campaign }

app.http('smsTriggerSingle', {
  methods: ['POST', 'OPTIONS'],
  route: 'mgmt/sms/trigger',
  authLevel: 'anonymous',
  handler: async (req) => {
    if (req.method === 'OPTIONS') return { status: 204, headers: corsHeaders() };
    const authError = requireAdminKey(req);
    if (authError) return authError;

    let body = {};
    try { body = await req.json(); } catch {}

    const pool = await getPool();

    // Resolve the ping row
    let row = null;
    if (body.ping_id) {
      const r = await pool.request()
        .input('id', sql.UniqueIdentifier, body.ping_id)
        .query(`
          SELECT ip.id AS ping_id, ip.phone, ip.campaign, ip.vertical, ip.created_at,
                 cm.category_key, cm.campaignkit_id
          FROM inbound_pings ip
          JOIN category_mappings cm ON cm.campaign = ip.campaign AND cm.enabled = 1
          WHERE ip.id = @id
        `);
      row = r.recordset[0] ?? null;
    } else if (body.phone && body.campaign) {
      const r = await pool.request()
        .input('phone',    sql.NVarChar(20),  body.phone)
        .input('campaign', sql.NVarChar(255), body.campaign)
        .query(`
          SELECT TOP 1 ip.id AS ping_id, ip.phone, ip.campaign, ip.vertical, ip.created_at,
                 cm.category_key, cm.campaignkit_id
          FROM inbound_pings ip
          JOIN category_mappings cm ON cm.campaign = ip.campaign AND cm.enabled = 1
          WHERE ip.phone = @phone AND ip.campaign = @campaign
          ORDER BY ip.created_at DESC
        `);
      row = r.recordset[0] ?? null;
    }

    if (!row) {
      return { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders() }, body: JSON.stringify({ error: 'ping not found or campaign not in category_mappings' }) };
    }

    const triggerUrl = await getConfig('campaignkit_trigger_url');
    const apiKey     = await getConfig('campaignkit_api_key');
    const listId     = parseInt(await getConfig('campaignkit_list_id') ?? '92', 10);
    const result     = await fireSmsForPing(pool, row, { triggerUrl, apiKey, listId });

    return { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders() }, body: JSON.stringify(result) };
  },
});
