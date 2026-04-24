-- ─────────────────────────────────────────────────────────────────────────────
-- 003_mid_term_storage.sql
-- Mid-Term Storage (per-vertical, 180-day TTL) + Sequence Engine schema
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Per-vertical mid-term storage tables ─────────────────────────────────────
-- One table per vertical. expires_at = created_at + 180 days (indexed for pruning).
-- seq_state drives the sequencing engine state machine.

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'mts_auto')
BEGIN
  CREATE TABLE mts_auto (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    ping_id             UNIQUEIDENTIFIER   NOT NULL,
    phone               NVARCHAR(20)       NOT NULL,
    zip                 NVARCHAR(10)       NULL,
    publisher_id        NVARCHAR(255)      NOT NULL,
    subid               NVARCHAR(255)      NULL,
    campaign            NVARCHAR(255)      NOT NULL,
    vertical            AS N'auto'         PERSISTED,
    rtb_status          NVARCHAR(20)       NOT NULL,
    bid_amount          DECIMAL(10,4)      NULL,
    buyer_id            NVARCHAR(255)      NULL,
    routing_number      NVARCHAR(50)       NULL,
    won                 BIT                NOT NULL DEFAULT 0,
    seq_state           NVARCHAR(30)       NOT NULL DEFAULT 'new',
    requires_enrichment BIT                NOT NULL DEFAULT 0,
    enriched_at         DATETIMEOFFSET     NULL,
    created_at          DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    expires_at          AS DATEADD(day, 180, created_at) PERSISTED,
    CONSTRAINT PK_mts_auto PRIMARY KEY (id)
  );
  CREATE INDEX IX_mts_auto_phone      ON mts_auto (phone);
  CREATE INDEX IX_mts_auto_ping_id    ON mts_auto (ping_id);
  CREATE INDEX IX_mts_auto_seq_state  ON mts_auto (seq_state);
  CREATE INDEX IX_mts_auto_expires_at ON mts_auto (expires_at);
  CREATE INDEX IX_mts_auto_created_at ON mts_auto (created_at DESC);
END;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'mts_health')
BEGIN
  CREATE TABLE mts_health (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    ping_id             UNIQUEIDENTIFIER   NOT NULL,
    phone               NVARCHAR(20)       NOT NULL,
    zip                 NVARCHAR(10)       NULL,
    publisher_id        NVARCHAR(255)      NOT NULL,
    subid               NVARCHAR(255)      NULL,
    campaign            NVARCHAR(255)      NOT NULL,
    vertical            AS N'health'       PERSISTED,
    rtb_status          NVARCHAR(20)       NOT NULL,
    bid_amount          DECIMAL(10,4)      NULL,
    buyer_id            NVARCHAR(255)      NULL,
    routing_number      NVARCHAR(50)       NULL,
    won                 BIT                NOT NULL DEFAULT 0,
    seq_state           NVARCHAR(30)       NOT NULL DEFAULT 'new',
    requires_enrichment BIT                NOT NULL DEFAULT 0,
    enriched_at         DATETIMEOFFSET     NULL,
    created_at          DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    expires_at          AS DATEADD(day, 180, created_at) PERSISTED,
    CONSTRAINT PK_mts_health PRIMARY KEY (id)
  );
  CREATE INDEX IX_mts_health_phone      ON mts_health (phone);
  CREATE INDEX IX_mts_health_ping_id    ON mts_health (ping_id);
  CREATE INDEX IX_mts_health_seq_state  ON mts_health (seq_state);
  CREATE INDEX IX_mts_health_expires_at ON mts_health (expires_at);
  CREATE INDEX IX_mts_health_created_at ON mts_health (created_at DESC);
END;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'mts_medicare')
BEGIN
  CREATE TABLE mts_medicare (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    ping_id             UNIQUEIDENTIFIER   NOT NULL,
    phone               NVARCHAR(20)       NOT NULL,
    zip                 NVARCHAR(10)       NULL,
    publisher_id        NVARCHAR(255)      NOT NULL,
    subid               NVARCHAR(255)      NULL,
    campaign            NVARCHAR(255)      NOT NULL,
    vertical            AS N'medicare'     PERSISTED,
    rtb_status          NVARCHAR(20)       NOT NULL,
    bid_amount          DECIMAL(10,4)      NULL,
    buyer_id            NVARCHAR(255)      NULL,
    routing_number      NVARCHAR(50)       NULL,
    won                 BIT                NOT NULL DEFAULT 0,
    seq_state           NVARCHAR(30)       NOT NULL DEFAULT 'new',
    requires_enrichment BIT                NOT NULL DEFAULT 0,
    enriched_at         DATETIMEOFFSET     NULL,
    created_at          DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    expires_at          AS DATEADD(day, 180, created_at) PERSISTED,
    CONSTRAINT PK_mts_medicare PRIMARY KEY (id)
  );
  CREATE INDEX IX_mts_medicare_phone      ON mts_medicare (phone);
  CREATE INDEX IX_mts_medicare_ping_id    ON mts_medicare (ping_id);
  CREATE INDEX IX_mts_medicare_seq_state  ON mts_medicare (seq_state);
  CREATE INDEX IX_mts_medicare_expires_at ON mts_medicare (expires_at);
  CREATE INDEX IX_mts_medicare_created_at ON mts_medicare (created_at DESC);
END;

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'mts_home')
BEGIN
  CREATE TABLE mts_home (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    ping_id             UNIQUEIDENTIFIER   NOT NULL,
    phone               NVARCHAR(20)       NOT NULL,
    zip                 NVARCHAR(10)       NULL,
    publisher_id        NVARCHAR(255)      NOT NULL,
    subid               NVARCHAR(255)      NULL,
    campaign            NVARCHAR(255)      NOT NULL,
    vertical            AS N'home'         PERSISTED,
    rtb_status          NVARCHAR(20)       NOT NULL,
    bid_amount          DECIMAL(10,4)      NULL,
    buyer_id            NVARCHAR(255)      NULL,
    routing_number      NVARCHAR(50)       NULL,
    won                 BIT                NOT NULL DEFAULT 0,
    seq_state           NVARCHAR(30)       NOT NULL DEFAULT 'new',
    requires_enrichment BIT                NOT NULL DEFAULT 0,
    enriched_at         DATETIMEOFFSET     NULL,
    created_at          DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    expires_at          AS DATEADD(day, 180, created_at) PERSISTED,
    CONSTRAINT PK_mts_home PRIMARY KEY (id)
  );
  CREATE INDEX IX_mts_home_phone      ON mts_home (phone);
  CREATE INDEX IX_mts_home_ping_id    ON mts_home (ping_id);
  CREATE INDEX IX_mts_home_seq_state  ON mts_home (seq_state);
  CREATE INDEX IX_mts_home_expires_at ON mts_home (expires_at);
  CREATE INDEX IX_mts_home_created_at ON mts_home (created_at DESC);
END;

-- ── contact_history (SMS 30-day suppression check) ───────────────────────────
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'contact_history')
BEGIN
  CREATE TABLE contact_history (
    id            UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    phone         NVARCHAR(20)       NOT NULL,
    contact_type  NVARCHAR(20)       NOT NULL DEFAULT 'sms',
    channel       NVARCHAR(50)       NULL,
    ping_id       UNIQUEIDENTIFIER   NULL,
    mts_id        UNIQUEIDENTIFIER   NULL,
    campaign      NVARCHAR(255)      NULL,
    vertical      NVARCHAR(50)       NULL,
    contacted_at  DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_contact_history PRIMARY KEY (id)
  );
  CREATE INDEX IX_contact_history_phone       ON contact_history (phone, contacted_at DESC);
  CREATE INDEX IX_contact_history_contacted   ON contact_history (contacted_at DESC);
  CREATE INDEX IX_contact_history_ping_id     ON contact_history (ping_id);
END;

-- ── category_mappings (campaign → CampaignKit category) ─────────────────────
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'category_mappings')
BEGIN
  CREATE TABLE category_mappings (
    id              UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    campaign        NVARCHAR(255)      NOT NULL,
    vertical        NVARCHAR(50)       NOT NULL,
    category_name   NVARCHAR(255)      NOT NULL,
    category_key    NVARCHAR(255)      NOT NULL,
    campaignkit_id  NVARCHAR(255)      NULL,
    enabled         BIT                NOT NULL DEFAULT 1,
    created_at      DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    updated_at      DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_category_mappings PRIMARY KEY (id),
    CONSTRAINT UQ_category_mappings UNIQUE (campaign, category_key)
  );
  CREATE INDEX IX_category_mappings_campaign ON category_mappings (campaign);
  CREATE INDEX IX_category_mappings_vertical ON category_mappings (vertical);
END;

-- ── phone_categories (phone → category membership) ───────────────────────────
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'phone_categories')
BEGIN
  CREATE TABLE phone_categories (
    id            UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    phone         NVARCHAR(20)       NOT NULL,
    category_key  NVARCHAR(255)      NOT NULL,
    source        NVARCHAR(50)       NULL,
    valid_until   DATETIMEOFFSET     NULL,
    created_at    DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_phone_categories PRIMARY KEY (id),
    CONSTRAINT UQ_phone_categories UNIQUE (phone, category_key)
  );
  CREATE INDEX IX_phone_categories_phone ON phone_categories (phone);
  CREATE INDEX IX_phone_categories_key   ON phone_categories (category_key);
END;

-- ── sequence_triggers (audit log for every state machine decision) ────────────
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'sequence_triggers')
BEGIN
  CREATE TABLE sequence_triggers (
    id                      UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    mts_id                  UNIQUEIDENTIFIER   NOT NULL,
    ping_id                 UNIQUEIDENTIFIER   NOT NULL,
    phone                   NVARCHAR(20)       NOT NULL,
    vertical                NVARCHAR(50)       NOT NULL,
    campaign                NVARCHAR(255)      NOT NULL,
    flow                    NVARCHAR(10)       NOT NULL,
    action                  NVARCHAR(50)       NOT NULL,
    was_enrichment_required BIT                NULL,
    was_contacted_30d       BIT                NULL,
    was_in_category         BIT                NULL,
    category_matched        NVARCHAR(255)      NULL,
    external_status_code    INT                NULL,
    external_response       NVARCHAR(MAX)      NULL,
    external_latency_ms     INT                NULL,
    triggered_at            DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_sequence_triggers PRIMARY KEY (id)
  );
  CREATE INDEX IX_seq_triggers_mts_id    ON sequence_triggers (mts_id);
  CREATE INDEX IX_seq_triggers_ping_id   ON sequence_triggers (ping_id);
  CREATE INDEX IX_seq_triggers_phone     ON sequence_triggers (phone);
  CREATE INDEX IX_seq_triggers_flow      ON sequence_triggers (flow, action);
  CREATE INDEX IX_seq_triggers_triggered ON sequence_triggers (triggered_at DESC);
END;

-- ── vertical_campaign_map (campaign name → vertical partition) ────────────────
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'vertical_campaign_map')
BEGIN
  CREATE TABLE vertical_campaign_map (
    campaign   NVARCHAR(255)   NOT NULL,
    vertical   NVARCHAR(50)    NOT NULL,
    enabled    BIT             NOT NULL DEFAULT 1,
    created_at DATETIMEOFFSET  NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_vertical_campaign_map PRIMARY KEY (campaign)
  );
  -- Default seed mappings — expand via Lovable UI
  INSERT INTO vertical_campaign_map (campaign, vertical) VALUES
    ('auto',     'auto'),
    ('health',   'health'),
    ('medicare', 'medicare'),
    ('home',     'home');
END;

-- ── system_config seeds for new keys ─────────────────────────────────────────
INSERT INTO system_config ([key], value)
SELECT k, v FROM (VALUES
  ('mts_enabled',                 '1'),
  ('sequencer_enabled',           '0'),
  ('campaignkit_trigger_url',     ''),
  ('campaignkit_api_key',         ''),
  ('enrichment_provider_url',     ''),
  ('sms_suppression_window_days', '30'),
  ('mts_default_vertical',        'auto')
) AS s(k, v)
WHERE NOT EXISTS (SELECT 1 FROM system_config WHERE [key] = s.k);
