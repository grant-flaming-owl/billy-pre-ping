/**
 * Dedicated inbound SMS endpoint — POST /rtb/sms
 *
 * Single record:  { phone, campaign, vertical?, ping_id?, mts_id? }
 * Batch:          { records: [{ phone, campaign, ... }, ...] }  (max 200)
 *
 * Decision tree per record:
 *   1. 30-day suppression check
 *   2. campaign → category_mappings lookup
 *   3. CampaignKit trigger
 *   4. contact_history + sequence_triggers write
 *
 * Single returns: { action, phone, campaign, ... }
 * Batch returns:  { processed, sent, failed, results: [...] }
 */
const { app } = require('@azure/functions');
const { getPool, sql } = require('../lib/db');
const { getConfig } = require('../lib/config-cache');
const { normalizePhone } = require('../lib/normalize');
const { v4: uuidv4 } = require('uuid');

app.http('smsInbound', {
  methods: ['POST', 'GET', 'OPTIONS'],
  route: 'sms',
  authLevel: 'anonymous',
  handler: async (req) => {
    if (req.method === 'OPTIONS') {
      return { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Allow-Headers': 'Content-Type' } };
    }

    let body = {};
    if (req.method === 'POST') {
      try { body = await req.json(); } catch {
        return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'invalid json' }) };
      }
    } else {
      req.query.forEach((val, key) => { body[key] = val; });
    }

    let pool;
    try {
      pool = await getPool();
    } catch (err) {
      console.error('[sms] DB connection failed:', err.message);
      return json({ action: 'error', reason: `DB connection failed: ${err.message}` }, 500);
    }

    // ── Batch mode ────────────────────────────────────────────────────────────
    if (Array.isArray(body.records)) {
      const records = body.records.slice(0, 200);
      const results = [];
      for (const rec of records) {
        try {
          results.push(await processSingleSms(pool, rec));
        } catch (err) {
          console.error('[sms] batch record error:', err.message);
          results.push({ action: 'error', reason: err.message, phone: rec.phone });
        }
      }
      const sent   = results.filter(r => r.action === 'triggered').length;
      const failed = results.filter(r => r.action === 'error').length;
      return json({ processed: results.length, sent, failed, results });
    }

    // ── Single mode ───────────────────────────────────────────────────────────
    try {
      const result = await processSingleSms(pool, body);
      const status = result._status ?? 200;
      delete result._status;
      return json(result, status);
    } catch (err) {
      console.error('[sms] unhandled error:', err.message);
      return json({ action: 'error', reason: err.message }, 500);
    }
  },
});

// ── Core SMS processor — one record ──────────────────────────────────────────
// Returns a plain object. In single mode, _status (if set) becomes the HTTP status.
// In batch mode, _status is ignored — every item is always included in results[].

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeUuid = v => (v && UUID_RE.test(v)) ? v : null;

async function processSingleSms(pool, record) {
  const rawPhone = record.phone ?? record.CID;
  const campaign = record.campaign ?? null;
  const vertical = record.vertical ?? null;
  const pingId   = safeUuid(record.ping_id);  // null if not a valid UUID
  const mtsId    = safeUuid(record.mts_id);   // null if not a valid UUID

  if (!rawPhone) return { action: 'error', reason: 'phone or CID is required', _status: 400 };
  if (!campaign) return { action: 'error', reason: 'campaign is required',     _status: 400 };

  const phone = normalizePhone(rawPhone);
  if (!phone) return { action: 'error', reason: 'invalid phone number', _status: 400 };

  // ── 1. Suppression check ───────────────────────────────────────────────────
  const suppressionDays = parseInt(await getConfig('sms_suppression_window_days') ?? '30', 10);
  const cutoff          = new Date(Date.now() - suppressionDays * 86_400_000);

  const suppressCheck = await pool.request()
    .input('phone',  sql.NVarChar(20),   phone)
    .input('cutoff', sql.DateTimeOffset, cutoff)
    .query(`
      SELECT TOP 1 contacted_at FROM contact_history
      WHERE phone = @phone AND contact_type = 'sms' AND contacted_at >= @cutoff
    `);

  if (suppressCheck.recordset.length) {
    await logTrigger(pool, { pingId, mtsId, phone, vertical, campaign, action: 'sms_suppressed', wasContactedThirtyDays: 1 });
    return { action: 'suppressed', reason: `SMS sent within last ${suppressionDays} days`, phone, campaign };
  }

  // ── 2. Category lookup ─────────────────────────────────────────────────────
  const catResult = await pool.request()
    .input('campaign', sql.NVarChar(255), campaign)
    .query(`
      SELECT TOP 1 category_key, campaignkit_id
      FROM category_mappings
      WHERE campaign = @campaign AND enabled = 1
    `);

  if (!catResult.recordset.length) {
    await logTrigger(pool, { pingId, mtsId, phone, vertical, campaign, action: 'no_category', wasContactedThirtyDays: 0, wasInCategory: 0 });
    return { action: 'no_category', reason: 'campaign not in category_mappings', phone, campaign };
  }

  const { category_key: categoryKey, campaignkit_id: campaignkitId } = catResult.recordset[0];

  // ── 3. CampaignKit trigger ─────────────────────────────────────────────────
  const triggerUrl     = await getConfig('campaignkit_trigger_url');
  const apiKey         = await getConfig('campaignkit_api_key');
  const listId         = parseInt(await getConfig('campaignkit_list_id') ?? campaignkitId ?? '92', 10);
  const formattedPhone = phone.startsWith('1') ? phone : `1${phone}`;

  if (!triggerUrl) {
    return { action: 'error', reason: 'campaignkit_trigger_url not configured', phone, campaign, _status: 500 };
  }

  let statusCode = null, latencyMs = 0, response = null, success = false;
  const start = Date.now();
  try {
    const res = await fetch(triggerUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body:    JSON.stringify({ list_id: listId, phone: formattedPhone, source_url: categoryKey }),
    });
    latencyMs  = Date.now() - start;
    statusCode = res.status;
    try { response = await res.json(); } catch { /* ok */ }
    success = res.ok;
  } catch (err) {
    latencyMs = Date.now() - start;
    response  = { error: err.message };
  }

  // ── 4. Persist ─────────────────────────────────────────────────────────────
  if (success) {
    await pool.request()
      .input('id',      sql.UniqueIdentifier, uuidv4())
      .input('phone',   sql.NVarChar(20),     phone)
      .input('type',    sql.NVarChar(20),     'sms')
      .input('channel', sql.NVarChar(50),     'campaignkit')
      .input('ping_id', sql.UniqueIdentifier, pingId ?? null)
      .input('mts_id',  sql.UniqueIdentifier, mtsId  ?? null)
      .input('campaign',sql.NVarChar(255),    campaign)
      .input('vertical',sql.NVarChar(50),     vertical ?? null)
      .query(`
        INSERT INTO contact_history
          (id, phone, contact_type, channel, ping_id, mts_id, campaign, vertical)
        VALUES
          (@id, @phone, @type, @channel, @ping_id, @mts_id, @campaign, @vertical)
      `);
  }

  await logTrigger(pool, {
    pingId, mtsId, phone, vertical, campaign,
    action:                 success ? 'campaignkit_trigger' : 'campaignkit_error',
    wasContactedThirtyDays: 0,
    wasInCategory:          1,
    categoryMatched:        categoryKey,
    externalStatusCode:     statusCode,
    externalResponse:       response ? JSON.stringify(response) : null,
    externalLatencyMs:      latencyMs,
  });

  if (!success) {
    return { action: 'error', reason: `CampaignKit returned HTTP ${statusCode}`, phone, campaign, category_key: categoryKey, status_code: statusCode, latency_ms: latencyMs, _status: 502 };
  }

  return { action: 'triggered', phone, campaign, category_key: categoryKey, list_id: listId, status_code: statusCode, latency_ms: latencyMs };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(body, status = 200) {
  return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function logTrigger(pool, {
  pingId, mtsId, phone, vertical, campaign, action,
  wasContactedThirtyDays = null, wasInCategory = null,
  categoryMatched = null, externalStatusCode = null,
  externalResponse = null, externalLatencyMs = null,
}) {
  await pool.request()
    .input('id',       sql.UniqueIdentifier,  uuidv4())
    .input('mts_id',   sql.UniqueIdentifier,  mtsId  ?? null)
    .input('ping_id',  sql.UniqueIdentifier,  pingId ?? null)
    .input('phone',    sql.NVarChar(20),       phone)
    .input('vertical', sql.NVarChar(50),       vertical ?? null)
    .input('campaign', sql.NVarChar(255),      campaign)
    .input('flow',     sql.NVarChar(10),       'sms')
    .input('action',   sql.NVarChar(50),       action)
    .input('enrich',   sql.Bit,                null)
    .input('contacted',sql.Bit,                wasContactedThirtyDays)
    .input('incat',    sql.Bit,                wasInCategory)
    .input('cat',      sql.NVarChar(255),      categoryMatched)
    .input('ext_code', sql.Int,                externalStatusCode)
    .input('ext_resp', sql.NVarChar(sql.MAX),  externalResponse)
    .input('ext_ms',   sql.Int,                externalLatencyMs)
    .query(`
      INSERT INTO sequence_triggers
        (id, mts_id, ping_id, phone, vertical, campaign, flow, action,
         was_enrichment_required, was_contacted_30d, was_in_category,
         category_matched, external_status_code, external_response, external_latency_ms)
      VALUES
        (@id, @mts_id, @ping_id, @phone, @vertical, @campaign, @flow, @action,
         @enrich, @contacted, @incat, @cat, @ext_code, @ext_resp, @ext_ms)
    `);
}
