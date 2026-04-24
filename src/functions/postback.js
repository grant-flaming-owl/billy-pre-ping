/**
 * POST /rtb/postback — Ringba sale-disposition postback receiver.
 *
 * Ringba fires this after a billable call completes. We resolve the ping/MTS
 * record from the call_id or phone, then run the post_sale_reenroll pipeline.
 *
 * Expected payload (Ringba postback variables):
 *   call_id, phone (or CID), campaign, vertical, publisher_id, buyer_id,
 *   call_duration, bid_amount, zipcode
 */
const { app } = require('@azure/functions');
const { normalizePhone } = require('../lib/normalize');
const { getPool, sql }   = require('../lib/db');
const { getConfig }      = require('../lib/config-cache');
const { runPipeline }    = require('../lib/pipeline');

app.http('postback', {
  methods: ['POST', 'GET'],
  route: 'postback',
  authLevel: 'anonymous',
  handler: async (request) => {
    let body = {};
    if (request.method === 'POST') {
      const ct = request.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        try { body = await request.json(); } catch { /* fall through */ }
      } else {
        // Ringba often sends form-encoded or query-string style
        const text = await request.text().catch(() => '');
        for (const [k, v] of new URLSearchParams(text)) body[k] = v;
      }
    } else {
      request.query.forEach((val, key) => { body[key] = val; });
    }

    const rawPhone = body.phone ?? body.CID ?? body.caller_id ?? null;
    if (!rawPhone) {
      return { status: 400, body: JSON.stringify({ error: 'phone or CID required' }) };
    }

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return { status: 400, body: JSON.stringify({ error: 'invalid phone number' }) };
    }

    // Check global pipeline enabled flag
    const enabled = await getConfig('pipeline_post_sale_reenroll_enabled');
    if (enabled !== '1') {
      return { status: 200, body: JSON.stringify({ ok: true, skipped: true, reason: 'pipeline disabled' }) };
    }

    const pool     = await getPool();
    const callId   = body.call_id    ?? body.callId    ?? null;
    const campaign = body.campaign   ?? null;
    const vertical = body.vertical   ?? null;
    const zip      = body.zipcode    ?? body.zip       ?? null;

    // Try to resolve ping_id + mts_id from call_id or most recent ping for this phone
    let pingId = null;
    let mtsId  = null;
    let campaignkitListId = null;
    let categoryKey       = null;

    const pingLookup = await pool.request()
      .input('phone',    sql.NVarChar(20),  phone)
      .input('campaign', sql.NVarChar(255), campaign ?? '')
      .query(`
        SELECT TOP 1 p.id AS ping_id, m.mts_id, m.campaign AS mts_campaign, m.vertical AS mts_vertical
        FROM inbound_pings p
        LEFT JOIN vw_ping_master m ON m.ping_id = p.id
        WHERE p.phone = @phone
          AND (@campaign = '' OR p.campaign = @campaign)
        ORDER BY p.created_at DESC
      `);
    if (pingLookup.recordset.length) {
      pingId = pingLookup.recordset[0].ping_id;
      mtsId  = pingLookup.recordset[0].mts_id;
    }

    // Resolve category + CampaignKit list for this phone/campaign
    const resolvedCampaign = campaign ?? pingLookup.recordset[0]?.mts_campaign ?? null;
    const resolvedVertical = vertical ?? pingLookup.recordset[0]?.mts_vertical ?? null;

    if (resolvedCampaign) {
      const catLookup = await pool.request()
        .input('phone',    sql.NVarChar(20),  phone)
        .input('campaign', sql.NVarChar(255), resolvedCampaign)
        .query(`
          SELECT TOP 1 cm.category_key, cm.campaignkit_id
          FROM phone_categories pc
          INNER JOIN category_mappings cm
            ON cm.category_key = pc.category_key
           AND cm.campaign = @campaign
           AND cm.enabled = 1
          WHERE pc.phone = @phone
            AND (pc.valid_until IS NULL OR pc.valid_until > SYSDATETIMEOFFSET())
        `);
      if (catLookup.recordset.length) {
        categoryKey       = catLookup.recordset[0].category_key;
        campaignkitListId = catLookup.recordset[0].campaignkit_id;
      }

      // Fallback: any enabled mapping for this campaign, regardless of phone_categories
      if (!campaignkitListId) {
        const mapLookup = await pool.request()
          .input('campaign', sql.NVarChar(255), resolvedCampaign)
          .query(`SELECT TOP 1 category_key, campaignkit_id FROM category_mappings WHERE campaign = @campaign AND enabled = 1`);
        if (mapLookup.recordset.length) {
          categoryKey       = mapLookup.recordset[0].category_key;
          campaignkitListId = mapLookup.recordset[0].campaignkit_id;
        }
      }
    }

    const ctx = {
      phone,
      callId,
      pingId,
      mtsId,
      campaign:         resolvedCampaign,
      vertical:         resolvedVertical,
      publisherId:      body.publisher_id ?? body.publisherId ?? null,
      buyerId:          body.buyer_id     ?? body.buyerId     ?? null,
      callDurationSec:  parseInt(body.call_duration ?? body.duration ?? '0', 10) || null,
      bidAmount:        parseFloat(body.bid_amount  ?? body.bidAmount ?? '0')    || null,
      categoryKey,
      campaignkitListId,
      _rawPayload: body,
    };

    // Run pipeline fire-and-forget — respond immediately to Ringba
    const { logId, finalAction, stageResults } = await runPipeline('post_sale_reenroll', ctx);

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, log_id: logId, action: finalAction, stages: stageResults }),
    };
  },
});
