-- ─────────────────────────────────────────────────────────────────────────────
-- 007_long_term_storage.sql
-- Long-Term Storage (LTS) — analytics, intelligence, and optimization layer.
--
-- Three dataset categories:
--   PAST    — historical aggregates and outcome events
--   PRESENT — active intelligence profiles (updated on every ping)
--   FUTURE  — predictive scores, recommended actions, scheduling
--
-- All LTS tables are append-friendly and designed for BI/ML consumption.
-- They are populated by background jobs and webhook handlers, never in the
-- hot ping path.
-- ─────────────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════════════
-- PAST — Historical records and outcome tracking
-- ════════════════════════════════════════════════════════════════════════════

-- ── lt_outcome_events ─────────────────────────────────────────────────────────
-- Raw outcome events tied to leads. Source of truth for all conversion reporting.
-- Events: call_connected, call_answered, transfer_completed, policy_sold,
--         form_submitted, sms_responded, opted_out, no_answer, voicemail
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lt_outcome_events')
BEGIN
  CREATE TABLE lt_outcome_events (
    id              UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    phone           NVARCHAR(20)       NOT NULL,
    ping_id         UNIQUEIDENTIFIER   NULL,
    mts_id          UNIQUEIDENTIFIER   NULL,
    vertical        NVARCHAR(50)       NULL,
    campaign        NVARCHAR(255)      NULL,
    publisher_id    NVARCHAR(255)      NULL,
    buyer_id        NVARCHAR(255)      NULL,
    channel         NVARCHAR(20)       NULL,   -- rtb | sms | email | call
    outcome_type    NVARCHAR(50)       NOT NULL,
    outcome_value   DECIMAL(10,4)      NULL,   -- revenue / bid amount at time of outcome
    duration_sec    INT                NULL,   -- call duration if applicable
    occurred_at     DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    source          NVARCHAR(50)       NULL,   -- ringba | campaignkit | manual | webhook
    raw_data        NVARCHAR(MAX)      NULL,
    CONSTRAINT PK_lt_outcome_events PRIMARY KEY (id)
  );
  CREATE INDEX IX_lt_outcomes_phone      ON lt_outcome_events (phone);
  CREATE INDEX IX_lt_outcomes_ping_id    ON lt_outcome_events (ping_id);
  CREATE INDEX IX_lt_outcomes_type       ON lt_outcome_events (outcome_type);
  CREATE INDEX IX_lt_outcomes_vertical   ON lt_outcome_events (vertical, campaign);
  CREATE INDEX IX_lt_outcomes_occurred   ON lt_outcome_events (occurred_at DESC);
  CREATE INDEX IX_lt_outcomes_buyer      ON lt_outcome_events (buyer_id);
END;

-- ── lt_daily_stats ────────────────────────────────────────────────────────────
-- Pre-aggregated daily rollups per vertical+campaign. Drives dashboard charts.
-- Populated nightly by a background job scanning inbound_pings + ringba_responses.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lt_daily_stats')
BEGIN
  CREATE TABLE lt_daily_stats (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    stat_date           DATE               NOT NULL,
    vertical            NVARCHAR(50)       NOT NULL,
    campaign            NVARCHAR(255)      NOT NULL,
    publisher_id        NVARCHAR(255)      NULL,
    total_pings         INT                NOT NULL DEFAULT 0,
    total_bids          INT                NOT NULL DEFAULT 0,
    total_wins          INT                NOT NULL DEFAULT 0,
    total_no_bids       INT                NOT NULL DEFAULT 0,
    total_errors        INT                NOT NULL DEFAULT 0,
    total_sms_sent      INT                NOT NULL DEFAULT 0,
    total_sms_responses INT                NOT NULL DEFAULT 0,
    total_conversions   INT                NOT NULL DEFAULT 0,
    avg_bid_amount      DECIMAL(10,4)      NULL,
    max_bid_amount      DECIMAL(10,4)      NULL,
    total_revenue       DECIMAL(12,4)      NULL,
    avg_response_ms     INT                NULL,
    p95_response_ms     INT                NULL,
    enrichment_rate     DECIMAL(5,4)       NULL,   -- pct requiring enrichment
    suppression_rate    DECIMAL(5,4)       NULL,   -- pct suppressed by 30d window
    category_match_rate DECIMAL(5,4)       NULL,
    computed_at         DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_lt_daily_stats PRIMARY KEY (id),
    CONSTRAINT UQ_lt_daily_stats UNIQUE (stat_date, vertical, campaign, publisher_id)
  );
  CREATE INDEX IX_lt_daily_date      ON lt_daily_stats (stat_date DESC);
  CREATE INDEX IX_lt_daily_vertical  ON lt_daily_stats (vertical, campaign);
  CREATE INDEX IX_lt_daily_publisher ON lt_daily_stats (publisher_id);
END;

-- ── lt_publisher_quality ─────────────────────────────────────────────────────
-- Lifetime publisher performance scores. Updated incrementally.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lt_publisher_quality')
BEGIN
  CREATE TABLE lt_publisher_quality (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    publisher_id        NVARCHAR(255)      NOT NULL,
    vertical            NVARCHAR(50)       NOT NULL,
    total_pings         INT                NOT NULL DEFAULT 0,
    bid_rate            DECIMAL(5,4)       NULL,
    win_rate            DECIMAL(5,4)       NULL,
    avg_bid_amount      DECIMAL(10,4)      NULL,
    duplicate_rate      DECIMAL(5,4)       NULL,
    invalid_phone_rate  DECIMAL(5,4)       NULL,
    avg_response_ms     INT                NULL,
    quality_score       DECIMAL(5,2)       NULL,   -- 0-100 composite score
    quality_tier        NVARCHAR(20)       NULL,   -- platinum | gold | silver | bronze
    first_ping_at       DATETIMEOFFSET     NULL,
    last_ping_at        DATETIMEOFFSET     NULL,
    updated_at          DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_lt_publisher_quality PRIMARY KEY (id),
    CONSTRAINT UQ_lt_publisher_quality UNIQUE (publisher_id, vertical)
  );
  CREATE INDEX IX_lt_pub_quality_score ON lt_publisher_quality (quality_score DESC);
  CREATE INDEX IX_lt_pub_quality_tier  ON lt_publisher_quality (quality_tier);
END;

-- ════════════════════════════════════════════════════════════════════════════
-- PRESENT — Live intelligence profiles (upserted on each relevant event)
-- ════════════════════════════════════════════════════════════════════════════

-- ── lt_phone_profile ──────────────────────────────────────────────────────────
-- One row per phone number. Aggregated intelligence updated on every ping.
-- The single source of truth for what we know about a phone number.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lt_phone_profile')
BEGIN
  CREATE TABLE lt_phone_profile (
    id                    UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    phone                 NVARCHAR(20)       NOT NULL,
    -- Geography
    zip                   NVARCHAR(10)       NULL,
    city                  NVARCHAR(100)      NULL,
    state                 NVARCHAR(50)       NULL,
    dma                   NVARCHAR(100)      NULL,   -- Designated Market Area
    county                NVARCHAR(100)      NULL,
    timezone              NVARCHAR(50)       NULL,   -- America/New_York etc
    -- Activity
    first_seen_at         DATETIMEOFFSET     NULL,
    last_seen_at          DATETIMEOFFSET     NULL,
    total_pings           INT                NOT NULL DEFAULT 0,
    total_bids            INT                NOT NULL DEFAULT 0,
    total_wins            INT                NOT NULL DEFAULT 0,
    total_sms_sent        INT                NOT NULL DEFAULT 0,
    total_sms_responses   INT                NOT NULL DEFAULT 0,
    total_conversions     INT                NOT NULL DEFAULT 0,
    -- Bid intelligence
    avg_bid_amount        DECIMAL(10,4)      NULL,
    max_bid_amount        DECIMAL(10,4)      NULL,
    last_bid_amount       DECIMAL(10,4)      NULL,
    last_bid_at           DATETIMEOFFSET     NULL,
    -- Verticals seen
    verticals_seen        NVARCHAR(500)      NULL,   -- JSON array: ["auto","health"]
    campaigns_seen        NVARCHAR(MAX)      NULL,   -- JSON array of campaign names
    -- SMS / contact state
    sms_opt_out           BIT                NOT NULL DEFAULT 0,
    sms_opt_out_at        DATETIMEOFFSET     NULL,
    last_contacted_at     DATETIMEOFFSET     NULL,
    last_contact_channel  NVARCHAR(20)       NULL,
    -- CampaignKit membership
    ck_list_ids           NVARCHAR(MAX)      NULL,   -- JSON array of list IDs
    ck_enrolled_count     INT                NOT NULL DEFAULT 0,
    -- Enrichment
    enriched              BIT                NOT NULL DEFAULT 0,
    enriched_at           DATETIMEOFFSET     NULL,
    enrichment_source     NVARCHAR(50)       NULL,
    updated_at            DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_lt_phone_profile PRIMARY KEY (id),
    CONSTRAINT UQ_lt_phone_profile UNIQUE (phone)
  );
  CREATE INDEX IX_lt_phone_zip       ON lt_phone_profile (zip);
  CREATE INDEX IX_lt_phone_state     ON lt_phone_profile (state);
  CREATE INDEX IX_lt_phone_dma       ON lt_phone_profile (dma);
  CREATE INDEX IX_lt_phone_last_seen ON lt_phone_profile (last_seen_at DESC);
  CREATE INDEX IX_lt_phone_bids      ON lt_phone_profile (total_bids DESC);
END;

-- ── lt_geo_intelligence ───────────────────────────────────────────────────────
-- Per-zip analytics aggregated from all pings. Used for location-based routing
-- and time-zone-aware contact scheduling.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lt_geo_intelligence')
BEGIN
  CREATE TABLE lt_geo_intelligence (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    zip                 NVARCHAR(10)       NOT NULL,
    state               NVARCHAR(50)       NULL,
    dma                 NVARCHAR(100)      NULL,
    county              NVARCHAR(100)      NULL,
    timezone            NVARCHAR(50)       NULL,
    -- Volume and performance
    total_pings         INT                NOT NULL DEFAULT 0,
    total_bids          INT                NOT NULL DEFAULT 0,
    bid_rate            DECIMAL(5,4)       NULL,
    avg_bid_amount      DECIMAL(10,4)      NULL,
    -- By vertical (JSON: {"auto": {"pings":10,"bid_rate":0.8}, "health": {...}})
    vertical_breakdown  NVARCHAR(MAX)      NULL,
    -- Contact performance
    avg_sms_response_rate DECIMAL(5,4)     NULL,
    best_contact_hour   TINYINT            NULL,   -- 0-23 local time
    best_contact_day    TINYINT            NULL,   -- 0=Sun … 6=Sat
    updated_at          DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_lt_geo_intelligence PRIMARY KEY (id),
    CONSTRAINT UQ_lt_geo_intelligence UNIQUE (zip)
  );
  CREATE INDEX IX_lt_geo_state ON lt_geo_intelligence (state);
  CREATE INDEX IX_lt_geo_dma   ON lt_geo_intelligence (dma);
END;

-- ════════════════════════════════════════════════════════════════════════════
-- FUTURE — Predictive and prescriptive optimization
-- ════════════════════════════════════════════════════════════════════════════

-- ── lt_lead_scores ────────────────────────────────────────────────────────────
-- Predictive lead scores per phone × vertical. Refreshed by scoring jobs.
-- score_factors is a JSON object explaining the score components.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lt_lead_scores')
BEGIN
  CREATE TABLE lt_lead_scores (
    id              UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    phone           NVARCHAR(20)       NOT NULL,
    vertical        NVARCHAR(50)       NOT NULL,
    score           DECIMAL(5,2)       NOT NULL,   -- 0.00 - 100.00
    score_tier      NVARCHAR(20)       NULL,        -- hot | warm | cold | dormant
    score_factors   NVARCHAR(MAX)      NULL,        -- JSON: {"bid_history":20,"geo":15,...}
    conversion_prob DECIMAL(5,4)       NULL,        -- estimated P(convert)
    estimated_value DECIMAL(10,4)      NULL,        -- estimated revenue if converted
    model_version   NVARCHAR(50)       NULL,
    scored_at       DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    expires_at      AS DATEADD(day, 30, scored_at) PERSISTED,
    CONSTRAINT PK_lt_lead_scores PRIMARY KEY (id),
    CONSTRAINT UQ_lt_lead_scores UNIQUE (phone, vertical)
  );
  CREATE INDEX IX_lt_scores_score    ON lt_lead_scores (score DESC);
  CREATE INDEX IX_lt_scores_tier     ON lt_lead_scores (score_tier);
  CREATE INDEX IX_lt_scores_expires  ON lt_lead_scores (expires_at);
  CREATE INDEX IX_lt_scores_vertical ON lt_lead_scores (vertical, score DESC);
END;

-- ── lt_contact_schedule ───────────────────────────────────────────────────────
-- Recommended next contact window per phone, computed from response pattern
-- analysis. Populated by the optimization engine.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lt_contact_schedule')
BEGIN
  CREATE TABLE lt_contact_schedule (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    phone               NVARCHAR(20)       NOT NULL,
    vertical            NVARCHAR(50)       NULL,
    campaign            NVARCHAR(255)      NULL,
    -- Recommended window
    recommended_channel NVARCHAR(20)       NULL,   -- sms | call | email
    recommended_at      DATETIMEOFFSET     NULL,   -- specific recommended datetime (UTC)
    recommended_hour    TINYINT            NULL,   -- fallback: best hour (0-23 local)
    recommended_day     TINYINT            NULL,   -- fallback: best dow (0=Sun)
    -- Rationale
    confidence          DECIMAL(5,4)       NULL,   -- 0-1
    reason              NVARCHAR(500)      NULL,
    -- Status
    status              NVARCHAR(20)       NOT NULL DEFAULT 'pending',
    -- pending | sent | expired | skipped
    created_at          DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    expires_at          DATETIMEOFFSET     NULL,
    CONSTRAINT PK_lt_contact_schedule PRIMARY KEY (id)
  );
  CREATE INDEX IX_lt_sched_phone     ON lt_contact_schedule (phone);
  CREATE INDEX IX_lt_sched_pending   ON lt_contact_schedule (status, recommended_at);
  CREATE INDEX IX_lt_sched_vertical  ON lt_contact_schedule (vertical, recommended_at);
END;

-- ── lt_sequence_recommendations ──────────────────────────────────────────────
-- Recommended follow-up sequence steps per phone based on past performance
-- of similar profiles. Drives the SMS sequencer's decision making.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lt_sequence_recommendations')
BEGIN
  CREATE TABLE lt_sequence_recommendations (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    phone               NVARCHAR(20)       NOT NULL,
    mts_id              UNIQUEIDENTIFIER   NULL,
    vertical            NVARCHAR(50)       NULL,
    campaign            NVARCHAR(255)      NULL,
    step_number         INT                NOT NULL DEFAULT 1,
    channel             NVARCHAR(20)       NULL,   -- sms | call | email
    action              NVARCHAR(100)      NULL,   -- campaignkit_trigger | ringba_direct | hold
    delay_hours         INT                NULL,   -- hours after previous step
    message_template    NVARCHAR(500)      NULL,
    reason              NVARCHAR(500)      NULL,
    status              NVARCHAR(20)       NOT NULL DEFAULT 'pending',
    created_at          DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    executed_at         DATETIMEOFFSET     NULL,
    CONSTRAINT PK_lt_sequence_recs PRIMARY KEY (id)
  );
  CREATE INDEX IX_lt_seqrec_phone    ON lt_sequence_recommendations (phone);
  CREATE INDEX IX_lt_seqrec_mts_id   ON lt_sequence_recommendations (mts_id);
  CREATE INDEX IX_lt_seqrec_status   ON lt_sequence_recommendations (status, created_at);
END;

-- ── lt_messaging_performance ──────────────────────────────────────────────────
-- Aggregate performance per message template / campaign / channel.
-- Drives A/B testing and template optimization.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'lt_messaging_performance')
BEGIN
  CREATE TABLE lt_messaging_performance (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    template_id         NVARCHAR(255)      NULL,   -- CampaignKit template ID if applicable
    channel             NVARCHAR(20)       NOT NULL,
    vertical            NVARCHAR(50)       NULL,
    campaign            NVARCHAR(255)      NULL,
    -- Delivery stats
    total_sent          INT                NOT NULL DEFAULT 0,
    total_delivered     INT                NOT NULL DEFAULT 0,
    total_failed        INT                NOT NULL DEFAULT 0,
    total_responses     INT                NOT NULL DEFAULT 0,
    total_opt_outs      INT                NOT NULL DEFAULT 0,
    total_conversions   INT                NOT NULL DEFAULT 0,
    -- Rates
    delivery_rate       DECIMAL(5,4)       NULL,
    response_rate       DECIMAL(5,4)       NULL,
    conversion_rate     DECIMAL(5,4)       NULL,
    opt_out_rate        DECIMAL(5,4)       NULL,
    -- Timing
    avg_response_hours  DECIMAL(8,2)       NULL,
    updated_at          DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_lt_msg_perf PRIMARY KEY (id),
    CONSTRAINT UQ_lt_msg_perf UNIQUE (template_id, channel, vertical, campaign)
  );
  CREATE INDEX IX_lt_msg_perf_channel  ON lt_messaging_performance (channel, vertical);
  CREATE INDEX IX_lt_msg_perf_conv     ON lt_messaging_performance (conversion_rate DESC);
END;

-- ── system_config seeds ───────────────────────────────────────────────────────
INSERT INTO system_config ([key], value)
SELECT k, v FROM (VALUES
  ('lts_enabled',              '1'),
  ('lts_score_refresh_days',   '7'),    -- re-score leads every N days
  ('lts_stats_rollup_hour',    '2'),    -- UTC hour to run daily stats job
  ('lts_phone_profile_enabled','1'),
  ('lts_geo_intelligence_enabled', '1')
) AS s(k, v)
WHERE NOT EXISTS (SELECT 1 FROM system_config WHERE [key] = s.k);
