-- ─────────────────────────────────────────────────────────────────────────────
-- 006_campaignkit_storage.sql
-- CampaignKit data mirrored into Azure SQL for cross-referencing against MTS.
--
-- Tables:
--   campaignkit_lists     — audience lists synced from CampaignKit
--   campaignkit_contacts  — phone enrollment status per list
--   campaignkit_messages  — delivery/response events per contact
-- ─────────────────────────────────────────────────────────────────────────────

-- ── campaignkit_lists ─────────────────────────────────────────────────────────
-- Mirrors CampaignKit list/audience objects.
-- Synced via POST /mgmt/campaignkit/lists/sync from the Lovable UI.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'campaignkit_lists')
BEGIN
  CREATE TABLE campaignkit_lists (
    id                UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    campaignkit_id    NVARCHAR(255)      NOT NULL,   -- CampaignKit's own list ID
    name              NVARCHAR(255)      NOT NULL,
    description       NVARCHAR(1000)     NULL,
    vertical          NVARCHAR(50)       NULL,
    campaign          NVARCHAR(255)      NULL,       -- maps to category_mappings.campaign
    category_key      NVARCHAR(255)      NULL,       -- maps to category_mappings.category_key
    status            NVARCHAR(50)       NOT NULL DEFAULT 'active',
    member_count      INT                NULL,
    last_synced_at    DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    created_at        DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    updated_at        DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    raw_data          NVARCHAR(MAX)      NULL,       -- full JSON from CampaignKit API
    CONSTRAINT PK_campaignkit_lists PRIMARY KEY (id),
    CONSTRAINT UQ_campaignkit_lists UNIQUE (campaignkit_id)
  );
  CREATE INDEX IX_ck_lists_campaign     ON campaignkit_lists (campaign);
  CREATE INDEX IX_ck_lists_vertical     ON campaignkit_lists (vertical);
  CREATE INDEX IX_ck_lists_category_key ON campaignkit_lists (category_key);
END;

-- ── campaignkit_contacts ──────────────────────────────────────────────────────
-- Per-phone enrollment record within a CampaignKit list.
-- Created when a CampaignKit trigger fires (sequence_triggers.action = 'campaignkit_trigger').
-- Updated when CampaignKit posts delivery/status webhooks back.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'campaignkit_contacts')
BEGIN
  CREATE TABLE campaignkit_contacts (
    id                    UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    phone                 NVARCHAR(20)       NOT NULL,
    campaignkit_list_id   NVARCHAR(255)      NOT NULL,   -- CampaignKit list ID
    campaignkit_contact_id NVARCHAR(255)     NULL,        -- CampaignKit's contact ID (set on first response)
    ping_id               UNIQUEIDENTIFIER   NULL,
    mts_id                UNIQUEIDENTIFIER   NULL,
    campaign              NVARCHAR(255)      NULL,
    vertical              NVARCHAR(50)       NULL,
    category_key          NVARCHAR(255)      NULL,
    enroll_status         NVARCHAR(50)       NOT NULL DEFAULT 'pending',
    -- pending | enrolled | active | opted_out | bounced | completed
    enrolled_at           DATETIMEOFFSET     NULL,
    last_message_at       DATETIMEOFFSET     NULL,
    last_response_at      DATETIMEOFFSET     NULL,
    message_count         INT                NOT NULL DEFAULT 0,
    response_count        INT                NOT NULL DEFAULT 0,
    opted_out_at          DATETIMEOFFSET     NULL,
    opt_out_reason        NVARCHAR(255)      NULL,
    created_at            DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    updated_at            DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    raw_data              NVARCHAR(MAX)      NULL,
    CONSTRAINT PK_campaignkit_contacts PRIMARY KEY (id),
    CONSTRAINT UQ_campaignkit_contacts UNIQUE (phone, campaignkit_list_id)
  );
  CREATE INDEX IX_ck_contacts_phone      ON campaignkit_contacts (phone);
  CREATE INDEX IX_ck_contacts_list       ON campaignkit_contacts (campaignkit_list_id);
  CREATE INDEX IX_ck_contacts_ping_id    ON campaignkit_contacts (ping_id);
  CREATE INDEX IX_ck_contacts_mts_id     ON campaignkit_contacts (mts_id);
  CREATE INDEX IX_ck_contacts_status     ON campaignkit_contacts (enroll_status);
  CREATE INDEX IX_ck_contacts_enrolled   ON campaignkit_contacts (enrolled_at DESC);
END;

-- ── campaignkit_messages ──────────────────────────────────────────────────────
-- Individual message delivery events. One row per outbound message attempt.
-- Populated via CampaignKit webhook callbacks or manual sync.
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'campaignkit_messages')
BEGIN
  CREATE TABLE campaignkit_messages (
    id                     UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    campaignkit_contact_id NVARCHAR(255)      NULL,
    campaignkit_message_id NVARCHAR(255)      NULL,
    phone                  NVARCHAR(20)       NOT NULL,
    campaignkit_list_id    NVARCHAR(255)      NOT NULL,
    channel                NVARCHAR(20)       NOT NULL DEFAULT 'sms',   -- sms | email | call
    direction              NVARCHAR(10)       NOT NULL DEFAULT 'outbound',
    status                 NVARCHAR(50)       NULL,
    -- queued | sent | delivered | failed | responded | opted_out
    message_body           NVARCHAR(MAX)      NULL,
    response_body          NVARCHAR(MAX)      NULL,
    sent_at                DATETIMEOFFSET     NULL,
    delivered_at           DATETIMEOFFSET     NULL,
    responded_at           DATETIMEOFFSET     NULL,
    latency_ms             INT                NULL,
    created_at             DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    raw_data               NVARCHAR(MAX)      NULL,
    CONSTRAINT PK_campaignkit_messages PRIMARY KEY (id)
  );
  CREATE INDEX IX_ck_messages_phone      ON campaignkit_messages (phone);
  CREATE INDEX IX_ck_messages_list       ON campaignkit_messages (campaignkit_list_id);
  CREATE INDEX IX_ck_messages_status     ON campaignkit_messages (status);
  CREATE INDEX IX_ck_messages_sent       ON campaignkit_messages (sent_at DESC);
  CREATE INDEX IX_ck_messages_ck_contact ON campaignkit_messages (campaignkit_contact_id);
END;

-- ── system_config seeds ───────────────────────────────────────────────────────
INSERT INTO system_config ([key], value)
SELECT k, v FROM (VALUES
  ('campaignkit_api_base_url', 'https://api.campaignkit.com'),
  ('campaignkit_webhook_secret', '')
) AS s(k, v)
WHERE NOT EXISTS (SELECT 1 FROM system_config WHERE [key] = s.k);
