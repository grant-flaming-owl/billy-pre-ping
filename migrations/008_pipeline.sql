-- ─────────────────────────────────────────────────────────────────────────────
-- 008_pipeline.sql
-- Pipeline execution framework.
--
-- Tables:
--   pipeline_stages  — stage definitions + enabled flags (Lovable toggles write here)
--   postback_log     — every Ringba postback received, with per-stage results
--   dnc_list         — phone numbers blocked from CampaignKit enrollment
-- ─────────────────────────────────────────────────────────────────────────────

-- ── pipeline_stages ───────────────────────────────────────────────────────────
-- One row per stage per macro. Lovable reads this for UI, writes enabled flag.
-- The backend reads this at runtime to decide which stages to execute.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'pipeline_stages')
BEGIN
  CREATE TABLE pipeline_stages (
    id           UNIQUEIDENTIFIER  NOT NULL DEFAULT NEWID(),
    macro_key    NVARCHAR(100)     NOT NULL,   -- e.g. 'post_sale_reenroll'
    stage_key    NVARCHAR(100)     NOT NULL,   -- e.g. 'dnc_check'
    stage_name   NVARCHAR(255)     NOT NULL,
    description  NVARCHAR(1000)    NULL,
    step_order   INT               NOT NULL,
    enabled      BIT               NOT NULL DEFAULT 1,
    config       NVARCHAR(MAX)     NULL,       -- JSON: provider URLs, thresholds, etc.
    created_at   DATETIMEOFFSET    NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    updated_at   DATETIMEOFFSET    NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_pipeline_stages PRIMARY KEY (id),
    CONSTRAINT UQ_pipeline_stages UNIQUE (macro_key, stage_key)
  );
  CREATE INDEX IX_pipeline_macro ON pipeline_stages (macro_key, step_order);

  -- Seed: post_sale_reenroll macro — mirrors the Lovable pipeline definition
  INSERT INTO pipeline_stages (macro_key, stage_key, stage_name, description, step_order, enabled) VALUES
  (
    'post_sale_reenroll', 'postback_received',
    'Post-sale postback received',
    'Ringba fires a sale-disposition postback to /rtb/postback after a billable call. Logs the outcome event.',
    1, 1
  ),
  (
    'post_sale_reenroll', 'dnc_check',
    'DNC check',
    'Reject phone if listed on the DNC registry before re-enrolling.',
    2, 1
  ),
  (
    'post_sale_reenroll', 'phone_type_check',
    'Phone type check',
    'Reject landline / VoIP / invalid numbers — only mobiles may proceed.',
    3, 1
  ),
  (
    'post_sale_reenroll', 'duplicate_in_list_check',
    'Duplicate-in-list check',
    'Reject if the phone is already actively enrolled in the target CampaignKit list.',
    4, 1
  ),
  (
    'post_sale_reenroll', 'campaignkit_enroll',
    'CampaignKit enroll (send_contact)',
    'POST send_contact to CampaignKit which fires the SMS campaign for that vertical.',
    5, 1
  );
END;

-- ── postback_log ──────────────────────────────────────────────────────────────
-- Every Ringba postback received. stage_results is a JSON array of each stage's
-- pass/fail/skip with the reason, so Lovable can show the full execution trace.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'postback_log')
BEGIN
  CREATE TABLE postback_log (
    id                UNIQUEIDENTIFIER  NOT NULL DEFAULT NEWID(),
    phone             NVARCHAR(20)      NOT NULL,
    call_id           NVARCHAR(255)     NULL,   -- Ringba call ID
    ping_id           UNIQUEIDENTIFIER  NULL,
    mts_id            UNIQUEIDENTIFIER  NULL,
    campaign          NVARCHAR(255)     NULL,
    vertical          NVARCHAR(50)      NULL,
    publisher_id      NVARCHAR(255)     NULL,
    buyer_id          NVARCHAR(255)     NULL,
    call_duration_sec INT               NULL,
    bid_amount        DECIMAL(10,4)     NULL,
    macro_key         NVARCHAR(100)     NOT NULL DEFAULT 'post_sale_reenroll',
    final_action      NVARCHAR(50)      NULL,
    -- enrolled | rejected_dnc | rejected_phone_type | rejected_duplicate | skipped | error
    stage_results     NVARCHAR(MAX)     NULL,   -- JSON array of stage execution results
    raw_payload       NVARCHAR(MAX)     NULL,
    received_at       DATETIMEOFFSET    NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_postback_log PRIMARY KEY (id)
  );
  CREATE INDEX IX_postback_phone     ON postback_log (phone);
  CREATE INDEX IX_postback_call_id   ON postback_log (call_id);
  CREATE INDEX IX_postback_ping_id   ON postback_log (ping_id);
  CREATE INDEX IX_postback_campaign  ON postback_log (campaign, vertical);
  CREATE INDEX IX_postback_action    ON postback_log (final_action);
  CREATE INDEX IX_postback_received  ON postback_log (received_at DESC);
END;

-- ── dnc_list ──────────────────────────────────────────────────────────────────
-- Phones blocked from CampaignKit enrollment.
-- Source can be: manual | ringba | tcpa | opt_out | scrub_service
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'dnc_list')
BEGIN
  CREATE TABLE dnc_list (
    id          UNIQUEIDENTIFIER  NOT NULL DEFAULT NEWID(),
    phone       NVARCHAR(20)      NOT NULL,
    source      NVARCHAR(50)      NOT NULL DEFAULT 'manual',
    reason      NVARCHAR(255)     NULL,
    added_at    DATETIMEOFFSET    NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    expires_at  DATETIMEOFFSET    NULL,   -- NULL = permanent
    added_by    NVARCHAR(255)     NULL,
    CONSTRAINT PK_dnc_list PRIMARY KEY (id),
    CONSTRAINT UQ_dnc_list UNIQUE (phone)
  );
  CREATE INDEX IX_dnc_phone   ON dnc_list (phone);
  CREATE INDEX IX_dnc_source  ON dnc_list (source);
  CREATE INDEX IX_dnc_expires ON dnc_list (expires_at);
END;

-- ── system_config seeds ───────────────────────────────────────────────────────
INSERT INTO system_config ([key], value)
SELECT k, v FROM (VALUES
  ('pipeline_post_sale_reenroll_enabled', '1'),
  ('phone_type_check_provider_url',       ''),   -- e.g. Twilio Lookup URL
  ('phone_type_check_api_key',            ''),
  ('postback_secret',                     '')    -- optional HMAC secret for Ringba postbacks
) AS s(k, v)
WHERE NOT EXISTS (SELECT 1 FROM system_config WHERE [key] = s.k);
