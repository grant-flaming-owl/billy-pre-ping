-- ─────────────────────────────────────────────────────────────────────────────
-- 005_backfill_mts.sql
-- Backfill existing inbound_pings + ringba_responses into the MTS framework.
--
-- Steps:
--   1. Seed real campaign names into vertical_campaign_map
--   2. Insert MTS rows for all pings not already present (routes via map, fallback to 'auto')
--   3. Backfill RTB-flow sequence_triggers for every new MTS row
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Seed known campaigns into vertical_campaign_map ────────────────────────
MERGE vertical_campaign_map AS target
USING (VALUES
  ('51f7ec7428bc415782e69c2eb8847d4d', 'auto'),
  ('ACA Insurance Call Flow',          'health'),
  ('auto_insurance',                   'auto'),
  ('00000000000000000000000000000000', 'auto'),
  ('test',                             'auto')
) AS src(campaign, vertical)
ON target.campaign = src.campaign
WHEN NOT MATCHED THEN
  INSERT (campaign, vertical, enabled) VALUES (src.campaign, src.vertical, 1);

-- ── 2. Backfill MTS rows ──────────────────────────────────────────────────────
-- One INSERT per vertical so each lands in the right partition table.
-- Pings whose campaign is still unmapped fall through to 'auto'.

-- auto
INSERT INTO mts_auto
  (id, ping_id, phone, zip, publisher_id, subid, campaign,
   rtb_status, bid_amount, buyer_id, routing_number, won,
   seq_state, requires_enrichment)
SELECT
  NEWID(),
  p.id,
  p.phone,
  p.zip,
  p.publisher_id,
  p.subid,
  p.campaign,
  COALESCE(rr.ringba_status, 'no_bid'),
  rr.bid_amount,
  rr.buyer_id,
  rr.routing_number,
  COALESCE(rr.won, 0),
  CASE WHEN p.zip IS NULL THEN 'enrichment_needed' ELSE 'ringba_direct' END,
  CASE WHEN p.zip IS NULL THEN 1 ELSE 0 END
FROM inbound_pings p
LEFT JOIN ringba_responses rr
  ON rr.ping_id = p.id
LEFT JOIN vertical_campaign_map vcm
  ON vcm.campaign = p.campaign AND vcm.enabled = 1
WHERE COALESCE(vcm.vertical, 'auto') = 'auto'
  AND NOT EXISTS (SELECT 1 FROM mts_auto WHERE ping_id = p.id);

-- health
INSERT INTO mts_health
  (id, ping_id, phone, zip, publisher_id, subid, campaign,
   rtb_status, bid_amount, buyer_id, routing_number, won,
   seq_state, requires_enrichment)
SELECT
  NEWID(),
  p.id,
  p.phone,
  p.zip,
  p.publisher_id,
  p.subid,
  p.campaign,
  COALESCE(rr.ringba_status, 'no_bid'),
  rr.bid_amount,
  rr.buyer_id,
  rr.routing_number,
  COALESCE(rr.won, 0),
  CASE WHEN p.zip IS NULL THEN 'enrichment_needed' ELSE 'ringba_direct' END,
  CASE WHEN p.zip IS NULL THEN 1 ELSE 0 END
FROM inbound_pings p
LEFT JOIN ringba_responses rr
  ON rr.ping_id = p.id
INNER JOIN vertical_campaign_map vcm
  ON vcm.campaign = p.campaign AND vcm.vertical = 'health' AND vcm.enabled = 1
WHERE NOT EXISTS (SELECT 1 FROM mts_health WHERE ping_id = p.id);

-- medicare
INSERT INTO mts_medicare
  (id, ping_id, phone, zip, publisher_id, subid, campaign,
   rtb_status, bid_amount, buyer_id, routing_number, won,
   seq_state, requires_enrichment)
SELECT
  NEWID(),
  p.id,
  p.phone,
  p.zip,
  p.publisher_id,
  p.subid,
  p.campaign,
  COALESCE(rr.ringba_status, 'no_bid'),
  rr.bid_amount,
  rr.buyer_id,
  rr.routing_number,
  COALESCE(rr.won, 0),
  CASE WHEN p.zip IS NULL THEN 'enrichment_needed' ELSE 'ringba_direct' END,
  CASE WHEN p.zip IS NULL THEN 1 ELSE 0 END
FROM inbound_pings p
LEFT JOIN ringba_responses rr
  ON rr.ping_id = p.id
INNER JOIN vertical_campaign_map vcm
  ON vcm.campaign = p.campaign AND vcm.vertical = 'medicare' AND vcm.enabled = 1
WHERE NOT EXISTS (SELECT 1 FROM mts_medicare WHERE ping_id = p.id);

-- home
INSERT INTO mts_home
  (id, ping_id, phone, zip, publisher_id, subid, campaign,
   rtb_status, bid_amount, buyer_id, routing_number, won,
   seq_state, requires_enrichment)
SELECT
  NEWID(),
  p.id,
  p.phone,
  p.zip,
  p.publisher_id,
  p.subid,
  p.campaign,
  COALESCE(rr.ringba_status, 'no_bid'),
  rr.bid_amount,
  rr.buyer_id,
  rr.routing_number,
  COALESCE(rr.won, 0),
  CASE WHEN p.zip IS NULL THEN 'enrichment_needed' ELSE 'ringba_direct' END,
  CASE WHEN p.zip IS NULL THEN 1 ELSE 0 END
FROM inbound_pings p
LEFT JOIN ringba_responses rr
  ON rr.ping_id = p.id
INNER JOIN vertical_campaign_map vcm
  ON vcm.campaign = p.campaign AND vcm.vertical = 'home' AND vcm.enabled = 1
WHERE NOT EXISTS (SELECT 1 FROM mts_home WHERE ping_id = p.id);

-- ── 3. Backfill RTB-flow sequence_triggers ────────────────────────────────────
-- One row per MTS record, representing the RTB routing decision.
-- SMS flow triggers are not backfilled — suppression/category state is unknown.

WITH all_mts AS (
  SELECT id AS mts_id, ping_id, phone, vertical, campaign, seq_state, requires_enrichment FROM mts_auto
  UNION ALL
  SELECT id, ping_id, phone, vertical, campaign, seq_state, requires_enrichment FROM mts_health
  UNION ALL
  SELECT id, ping_id, phone, vertical, campaign, seq_state, requires_enrichment FROM mts_medicare
  UNION ALL
  SELECT id, ping_id, phone, vertical, campaign, seq_state, requires_enrichment FROM mts_home
)
INSERT INTO sequence_triggers
  (id, mts_id, ping_id, phone, vertical, campaign,
   flow, action, was_enrichment_required)
SELECT
  NEWID(),
  m.mts_id,
  m.ping_id,
  m.phone,
  m.vertical,
  m.campaign,
  'rtb',
  CASE WHEN m.requires_enrichment = 1 THEN 'top_of_funnel' ELSE 'ringba_direct' END,
  m.requires_enrichment
FROM all_mts m
WHERE NOT EXISTS (
  SELECT 1 FROM sequence_triggers
  WHERE ping_id = m.ping_id AND flow = 'rtb'
);

-- ── Verify ────────────────────────────────────────────────────────────────────
SELECT 'mts_auto'     AS tbl, COUNT(*) AS rows FROM mts_auto    UNION ALL
SELECT 'mts_health',           COUNT(*)         FROM mts_health  UNION ALL
SELECT 'mts_medicare',         COUNT(*)         FROM mts_medicare UNION ALL
SELECT 'mts_home',             COUNT(*)         FROM mts_home    UNION ALL
SELECT 'seq_triggers_rtb',     COUNT(*)         FROM sequence_triggers WHERE flow = 'rtb';
