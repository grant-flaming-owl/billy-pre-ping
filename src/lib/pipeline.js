/**
 * Pipeline execution engine.
 *
 * Loads the ordered, enabled stages for a macro from pipeline_stages,
 * then runs each stage in sequence. Any stage returning { pass: false }
 * stops the chain and records the rejection reason.
 *
 * Stage results are written to postback_log.stage_results as a JSON array:
 * [
 *   { stage_key, stage_name, result: 'pass'|'fail'|'skip', reason, duration_ms },
 *   ...
 * ]
 */
const { getPool, sql } = require('./db');
const { getConfig } = require('./config-cache');
const { v4: uuidv4 } = require('uuid');

// ── Stage cache (60s TTL) ─────────────────────────────────────────────────────
let stageCache = { stages: {}, loadedAt: 0 };
const STAGE_CACHE_TTL = 60_000;

async function loadStages(pool, macroKey) {
  if (Date.now() - stageCache.loadedAt < STAGE_CACHE_TTL && stageCache.stages[macroKey]) {
    return stageCache.stages[macroKey];
  }
  const r = await pool.request()
    .input('macro', sql.NVarChar(100), macroKey)
    .query(`
      SELECT stage_key, stage_name, description, step_order, enabled, config
      FROM pipeline_stages
      WHERE macro_key = @macro
      ORDER BY step_order ASC
    `);
  stageCache.stages[macroKey] = r.recordset.map(s => ({
    ...s,
    config: s.config ? JSON.parse(s.config) : {},
  }));
  stageCache.loadedAt = Date.now();
  return stageCache.stages[macroKey];
}

function invalidatePipelineCache() { stageCache.loadedAt = 0; }

// ── Individual stage executors ────────────────────────────────────────────────

async function runPostbackReceived(pool, ctx) {
  // Always passes — just records the outcome event
  await pool.request()
    .input('id',          sql.UniqueIdentifier, uuidv4())
    .input('phone',       sql.NVarChar(20),     ctx.phone)
    .input('ping_id',     sql.UniqueIdentifier, ctx.pingId   ?? null)
    .input('mts_id',      sql.UniqueIdentifier, ctx.mtsId    ?? null)
    .input('vertical',    sql.NVarChar(50),     ctx.vertical ?? null)
    .input('campaign',    sql.NVarChar(255),    ctx.campaign ?? null)
    .input('publisher_id',sql.NVarChar(255),    ctx.publisherId ?? null)
    .input('buyer_id',    sql.NVarChar(255),    ctx.buyerId  ?? null)
    .input('call_id',     sql.NVarChar(255),    ctx.callId   ?? null)
    .input('duration',    sql.Int,              ctx.callDurationSec ?? null)
    .input('value',       sql.Decimal(10,4),    ctx.bidAmount ?? null)
    .query(`
      INSERT INTO lt_outcome_events
        (id, phone, ping_id, mts_id, vertical, campaign, publisher_id, buyer_id,
         channel, outcome_type, outcome_value, duration_sec, source, raw_data)
      VALUES
        (@id, @phone, @ping_id, @mts_id, @vertical, @campaign, @publisher_id, @buyer_id,
         'call', 'call_connected', @value, @duration, 'ringba',
         (SELECT @call_id AS call_id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER))
    `);
  return { pass: true, reason: 'Postback received and logged' };
}

async function runDncCheck(pool, ctx) {
  const r = await pool.request()
    .input('phone',  sql.NVarChar(20), ctx.phone)
    .query(`
      SELECT TOP 1 source, reason FROM dnc_list
      WHERE phone = @phone
        AND (expires_at IS NULL OR expires_at > SYSDATETIMEOFFSET())
    `);
  if (r.recordset.length) {
    const { source, reason } = r.recordset[0];
    return { pass: false, reason: `DNC match — source: ${source}${reason ? `, reason: ${reason}` : ''}` };
  }
  return { pass: true, reason: 'Not on DNC list' };
}

async function runPhoneTypeCheck(pool, ctx) {
  const providerUrl = await getConfig('phone_type_check_provider_url');
  const apiKey      = await getConfig('phone_type_check_api_key');

  // If no provider configured, pass through (configurable behaviour)
  if (!providerUrl) return { pass: true, reason: 'Phone type provider not configured — skipped' };

  try {
    const start = Date.now();
    const res   = await fetch(`${providerUrl}/${encodeURIComponent(ctx.phone)}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' },
    });
    const data      = await res.json().catch(() => ({}));
    const lineType  = data.line_type ?? data.lineType ?? data.type ?? null;
    const duration  = Date.now() - start;

    const blocked = ['landline', 'voip', 'invalid', 'tollfree'].includes((lineType ?? '').toLowerCase());
    return blocked
      ? { pass: false, reason: `Phone type rejected: ${lineType}`, meta: { line_type: lineType, latency_ms: duration } }
      : { pass: true,  reason: `Mobile verified: ${lineType ?? 'unknown'}`, meta: { line_type: lineType, latency_ms: duration } };
  } catch (err) {
    // Provider error — fail open (pass) to avoid blocking good leads
    return { pass: true, reason: `Phone type check error (fail-open): ${err.message}` };
  }
}

async function runDuplicateInListCheck(pool, ctx) {
  if (!ctx.campaignkitListId) return { pass: true, reason: 'No list ID — skipped' };

  const r = await pool.request()
    .input('phone',  sql.NVarChar(20),  ctx.phone)
    .input('listId', sql.NVarChar(255), ctx.campaignkitListId)
    .query(`
      SELECT TOP 1 enroll_status, enrolled_at FROM campaignkit_contacts
      WHERE phone = @phone AND campaignkit_list_id = @listId
        AND enroll_status IN ('pending','enrolled','active')
    `);
  if (r.recordset.length) {
    const { enroll_status, enrolled_at } = r.recordset[0];
    return { pass: false, reason: `Already ${enroll_status} in list since ${enrolled_at}` };
  }
  return { pass: true, reason: 'Not enrolled in target list' };
}

async function runCampaignKitEnroll(pool, ctx) {
  const triggerUrl = await getConfig('campaignkit_trigger_url');
  const apiKey     = await getConfig('campaignkit_api_key');
  const listId     = parseInt(await getConfig('campaignkit_list_id') ?? ctx.campaignkitListId ?? '92', 10);

  if (!triggerUrl) return { pass: false, reason: 'CampaignKit trigger URL not configured' };

  // Ensure phone has country code (CampaignKit expects e.g. 12345678910)
  const formattedPhone = ctx.phone.startsWith('1') ? ctx.phone : `1${ctx.phone}`;

  const start = Date.now();
  try {
    const res = await fetch(triggerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        list_id:    listId,
        phone:      formattedPhone,
        source_url: ctx.categoryKey,
      }),
    });
    const latencyMs = Date.now() - start;
    const response  = await res.json().catch(() => null);
    const ckContactId = response?.contact_id ?? response?.id ?? null;

    // Upsert campaignkit_contacts
    await pool.request()
      .input('id',      sql.UniqueIdentifier, uuidv4())
      .input('phone',   sql.NVarChar(20),     ctx.phone)
      .input('listId',  sql.NVarChar(255),    ctx.campaignkitListId ?? '')
      .input('ckId',    sql.NVarChar(255),    ckContactId)
      .input('pingId',  sql.UniqueIdentifier, ctx.pingId  ?? null)
      .input('mtsId',   sql.UniqueIdentifier, ctx.mtsId   ?? null)
      .input('campaign',sql.NVarChar(255),    ctx.campaign ?? null)
      .input('vertical',sql.NVarChar(50),     ctx.vertical ?? null)
      .input('catKey',  sql.NVarChar(255),    ctx.categoryKey ?? null)
      .query(`
        MERGE campaignkit_contacts AS t
        USING (SELECT @phone AS phone, @listId AS campaignkit_list_id) AS s
          ON t.phone = s.phone AND t.campaignkit_list_id = s.campaignkit_list_id
        WHEN MATCHED THEN
          UPDATE SET enroll_status = 'enrolled', enrolled_at = SYSDATETIMEOFFSET(),
                     campaignkit_contact_id = COALESCE(@ckId, t.campaignkit_contact_id),
                     updated_at = SYSDATETIMEOFFSET()
        WHEN NOT MATCHED THEN
          INSERT (id, phone, campaignkit_list_id, campaignkit_contact_id, ping_id, mts_id,
                  campaign, vertical, category_key, enroll_status, enrolled_at)
          VALUES (@id, @phone, @listId, @ckId, @pingId, @mtsId,
                  @campaign, @vertical, @catKey, 'enrolled', SYSDATETIMEOFFSET());
      `);

    // Log the message send
    await pool.request()
      .input('id',      sql.UniqueIdentifier, uuidv4())
      .input('phone',   sql.NVarChar(20),     ctx.phone)
      .input('listId',  sql.NVarChar(255),    ctx.campaignkitListId ?? '')
      .input('ckId',    sql.NVarChar(255),    ckContactId)
      .input('status',  sql.NVarChar(50),     res.ok ? 'sent' : 'failed')
      .input('latency', sql.Int,              latencyMs)
      .input('raw',     sql.NVarChar(sql.MAX),response ? JSON.stringify(response) : null)
      .query(`
        INSERT INTO campaignkit_messages
          (id, campaignkit_contact_id, phone, campaignkit_list_id, channel,
           direction, status, sent_at, latency_ms, raw_data)
        VALUES
          (@id, @ckId, @phone, @listId, 'sms',
           'outbound', @status, SYSDATETIMEOFFSET(), @latency, @raw)
      `);

    if (!res.ok) return { pass: false, reason: `CampaignKit returned HTTP ${res.status}`, meta: { status_code: res.status, latency_ms: latencyMs } };
    return { pass: true, reason: 'Enrolled in CampaignKit', meta: { contact_id: ckContactId, latency_ms: latencyMs } };
  } catch (err) {
    return { pass: false, reason: `CampaignKit enroll error: ${err.message}` };
  }
}

// ── Stage dispatch map ────────────────────────────────────────────────────────
const STAGE_RUNNERS = {
  postback_received:      runPostbackReceived,
  dnc_check:              runDncCheck,
  phone_type_check:       runPhoneTypeCheck,
  duplicate_in_list_check:runDuplicateInListCheck,
  campaignkit_enroll:     runCampaignKitEnroll,
};

// ── Main pipeline runner ──────────────────────────────────────────────────────
async function runPipeline(macroKey, ctx) {
  const pool   = await getPool();
  const stages = await loadStages(pool, macroKey);

  const stageResults = [];
  let finalAction    = 'completed';

  for (const stage of stages) {
    if (!stage.enabled) {
      stageResults.push({ stage_key: stage.stage_key, stage_name: stage.stage_name, result: 'skip', reason: 'Stage disabled' });
      continue;
    }

    const runner = STAGE_RUNNERS[stage.stage_key];
    if (!runner) {
      stageResults.push({ stage_key: stage.stage_key, stage_name: stage.stage_name, result: 'skip', reason: 'No runner implemented' });
      continue;
    }

    const t0 = Date.now();
    let outcome;
    try {
      outcome = await runner(pool, ctx);
    } catch (err) {
      outcome = { pass: false, reason: `Unhandled error: ${err.message}` };
    }
    const duration_ms = Date.now() - t0;

    stageResults.push({
      stage_key:   stage.stage_key,
      stage_name:  stage.stage_name,
      result:      outcome.pass ? 'pass' : 'fail',
      reason:      outcome.reason,
      meta:        outcome.meta ?? null,
      duration_ms,
    });

    if (!outcome.pass) {
      finalAction = `rejected_${stage.stage_key}`;
      break;
    }
  }

  // Determine final action label
  const lastPass = stageResults.filter(s => s.result === 'pass').pop();
  if (finalAction === 'completed') {
    finalAction = lastPass?.stage_key === 'campaignkit_enroll' ? 'enrolled' : 'completed';
  }

  // Write postback_log row
  const logId = ctx._logId ?? uuidv4();
  await pool.request()
    .input('id',         sql.UniqueIdentifier, logId)
    .input('phone',      sql.NVarChar(20),     ctx.phone)
    .input('callId',     sql.NVarChar(255),    ctx.callId   ?? null)
    .input('pingId',     sql.UniqueIdentifier, ctx.pingId   ?? null)
    .input('mtsId',      sql.UniqueIdentifier, ctx.mtsId    ?? null)
    .input('campaign',   sql.NVarChar(255),    ctx.campaign ?? null)
    .input('vertical',   sql.NVarChar(50),     ctx.vertical ?? null)
    .input('publisherId',sql.NVarChar(255),    ctx.publisherId ?? null)
    .input('buyerId',    sql.NVarChar(255),    ctx.buyerId  ?? null)
    .input('duration',   sql.Int,              ctx.callDurationSec ?? null)
    .input('bid',        sql.Decimal(10,4),    ctx.bidAmount ?? null)
    .input('macro',      sql.NVarChar(100),    macroKey)
    .input('action',     sql.NVarChar(50),     finalAction)
    .input('results',    sql.NVarChar(sql.MAX),JSON.stringify(stageResults))
    .input('raw',        sql.NVarChar(sql.MAX),ctx._rawPayload ? JSON.stringify(ctx._rawPayload) : null)
    .query(`
      INSERT INTO postback_log
        (id, phone, call_id, ping_id, mts_id, campaign, vertical, publisher_id, buyer_id,
         call_duration_sec, bid_amount, macro_key, final_action, stage_results, raw_payload)
      VALUES
        (@id, @phone, @callId, @pingId, @mtsId, @campaign, @vertical, @publisher_id, @buyerId,
         @duration, @bid, @macro, @action, @results, @raw)
    `);

  return { logId, finalAction, stageResults };
}

module.exports = { runPipeline, invalidatePipelineCache };
