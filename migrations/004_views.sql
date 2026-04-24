-- ─────────────────────────────────────────────────────────────────────────────
-- 004_views.sql  — Master VIEW (VIEW logging master from architecture diagram)
-- Unions all vertical partitions + joins full audit trail in one query surface.
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('vw_ping_master', 'V') IS NOT NULL
  DROP VIEW vw_ping_master;
GO

CREATE VIEW vw_ping_master AS

-- ── Combine all vertical MTS partitions ───────────────────────────────────────
WITH mts_all AS (
  SELECT id AS mts_id, ping_id, phone, zip, publisher_id, subid, campaign,
         vertical, rtb_status, bid_amount, buyer_id, routing_number, won,
         seq_state, requires_enrichment, enriched_at, created_at, expires_at
  FROM mts_auto
  UNION ALL
  SELECT id, ping_id, phone, zip, publisher_id, subid, campaign,
         vertical, rtb_status, bid_amount, buyer_id, routing_number, won,
         seq_state, requires_enrichment, enriched_at, created_at, expires_at
  FROM mts_health
  UNION ALL
  SELECT id, ping_id, phone, zip, publisher_id, subid, campaign,
         vertical, rtb_status, bid_amount, buyer_id, routing_number, won,
         seq_state, requires_enrichment, enriched_at, created_at, expires_at
  FROM mts_medicare
  UNION ALL
  SELECT id, ping_id, phone, zip, publisher_id, subid, campaign,
         vertical, rtb_status, bid_amount, buyer_id, routing_number, won,
         seq_state, requires_enrichment, enriched_at, created_at, expires_at
  FROM mts_home
)

SELECT
  -- ── Inbound ping (layer 1) ─────────────────────────────────────────────────
  p.id                    AS ping_id,
  p.phone,
  p.zip,
  p.zip_source,
  p.publisher_id,
  p.subid,
  p.campaign,
  p.ip,
  p.is_duplicate,
  p.raw_payload,
  p.created_at            AS ping_received_at,

  -- ── Ringba RTB response (layer 2) ─────────────────────────────────────────
  rr.id                   AS ringba_response_id,
  rr.ringba_status,
  rr.ringba_status_code,
  rr.bid_amount           AS ringba_bid_amount,
  rr.buyer_id             AS ringba_buyer_id,
  rr.routing_number       AS ringba_routing_number,
  rr.won                  AS ringba_won,
  rr.response_time_ms     AS ringba_response_ms,
  rr.outbound_payload,
  rr.raw_response         AS ringba_raw_response,
  rr.created_at           AS ringba_responded_at,

  -- ── Mid-term storage (layer 3) ─────────────────────────────────────────────
  mts.mts_id,
  mts.vertical,
  mts.seq_state,
  mts.requires_enrichment,
  mts.enriched_at,
  mts.bid_amount          AS mts_bid_amount,
  mts.created_at          AS mts_stored_at,
  mts.expires_at          AS mts_expires_at,

  -- ── Sequencer / SMS flow (layer 4 — most recent trigger per ping per flow) ─
  seq_rtb.action          AS seq_rtb_action,
  seq_rtb.was_enrichment_required,
  seq_rtb.triggered_at    AS seq_rtb_triggered_at,

  seq_sms.action          AS seq_sms_action,
  seq_sms.was_contacted_30d,
  seq_sms.was_in_category,
  seq_sms.category_matched,
  seq_sms.external_status_code AS sms_ext_status_code,
  seq_sms.external_latency_ms  AS sms_ext_latency_ms,
  seq_sms.triggered_at         AS seq_sms_triggered_at

FROM inbound_pings p

-- Ringba response — 1:1 with ping
LEFT JOIN ringba_responses rr
  ON rr.ping_id = p.id

-- MTS row — 1:1 (one vertical partition row per ping)
LEFT JOIN mts_all mts
  ON mts.ping_id = p.id

-- Most recent RTB sequencer trigger for this ping
LEFT JOIN sequence_triggers seq_rtb
  ON seq_rtb.ping_id = p.id
 AND seq_rtb.flow    = 'rtb'
 AND seq_rtb.id      = (
       SELECT TOP 1 id FROM sequence_triggers
       WHERE ping_id = p.id AND flow = 'rtb'
       ORDER BY triggered_at DESC
     )

-- Most recent SMS sequencer trigger for this ping
LEFT JOIN sequence_triggers seq_sms
  ON seq_sms.ping_id = p.id
 AND seq_sms.flow    = 'sms'
 AND seq_sms.id      = (
       SELECT TOP 1 id FROM sequence_triggers
       WHERE ping_id = p.id AND flow = 'sms'
       ORDER BY triggered_at DESC
     );
GO
