-- Billy Pre-Ping System — Phase 1 Schema
-- Run against Azure SQL Database

-- ── inbound_pings ────────────────────────────────────────────────────────────
CREATE TABLE inbound_pings (
    id               UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    phone            NVARCHAR(20)       NOT NULL,
    zip              NVARCHAR(10)       NULL,
    zip_source       NVARCHAR(20)       NULL,   -- 'publisher' | 'ip' | null
    publisher_id     NVARCHAR(255)      NOT NULL,
    subid            NVARCHAR(255)      NULL,
    campaign         NVARCHAR(255)      NOT NULL,
    ip               NVARCHAR(50)       NULL,
    is_duplicate     BIT                NOT NULL DEFAULT 0,
    raw_payload      NVARCHAR(MAX)      NULL,   -- full original JSON payload
    created_at       DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_inbound_pings PRIMARY KEY (id)
);

CREATE INDEX IX_inbound_pings_phone        ON inbound_pings (phone);
CREATE INDEX IX_inbound_pings_zip          ON inbound_pings (zip);
CREATE INDEX IX_inbound_pings_publisher_id ON inbound_pings (publisher_id);
CREATE INDEX IX_inbound_pings_campaign     ON inbound_pings (campaign);
CREATE INDEX IX_inbound_pings_created_at   ON inbound_pings (created_at DESC);

-- ── ringba_responses ─────────────────────────────────────────────────────────
CREATE TABLE ringba_responses (
    id                  UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    ping_id             UNIQUEIDENTIFIER   NOT NULL,
    bid_amount          DECIMAL(10, 4)     NULL,
    buyer_id            NVARCHAR(255)      NULL,
    routing_number      NVARCHAR(50)       NULL,
    won                 BIT                NULL,
    response_time_ms    INT                NULL,
    call_forwarded      BIT                NOT NULL DEFAULT 0,
    call_forwarded_at   DATETIMEOFFSET     NULL,
    raw_response        NVARCHAR(MAX)      NULL,   -- full Ringba response JSON
    created_at          DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_ringba_responses PRIMARY KEY (id),
    CONSTRAINT FK_ringba_responses_ping FOREIGN KEY (ping_id)
        REFERENCES inbound_pings (id)
);

CREATE INDEX IX_ringba_responses_ping_id ON ringba_responses (ping_id);

-- ── fanout_endpoints ─────────────────────────────────────────────────────────
CREATE TABLE fanout_endpoints (
    id          UNIQUEIDENTIFIER   NOT NULL DEFAULT NEWID(),
    name        NVARCHAR(255)      NOT NULL,
    url         NVARCHAR(2048)     NOT NULL,
    method      NVARCHAR(10)       NOT NULL DEFAULT 'POST',
    enabled     BIT                NOT NULL DEFAULT 1,
    rules       NVARCHAR(MAX)      NULL,   -- JSON object; empty/null = receive all
    created_at  DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_fanout_endpoints PRIMARY KEY (id),
    CONSTRAINT CK_fanout_endpoints_method CHECK (method IN ('POST', 'GET'))
);

-- ── system_config ─────────────────────────────────────────────────────────────
-- Key-value store for runtime-editable configuration (Ringba URLs, etc.)
CREATE TABLE system_config (
    [key]       NVARCHAR(255)      NOT NULL,
    value       NVARCHAR(MAX)      NOT NULL,
    updated_at  DATETIMEOFFSET     NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    CONSTRAINT PK_system_config PRIMARY KEY ([key])
);

-- Seed default config keys — fill values via the admin UI before going live
INSERT INTO system_config ([key], value) VALUES ('ringba_rtb_url',         '');
INSERT INTO system_config ([key], value) VALUES ('ringba_call_url',        '');
INSERT INTO system_config ([key], value) VALUES ('ringba_rtb_timeout_ms',  '45');
INSERT INTO system_config ([key], value) VALUES ('dedup_window_seconds',   '60');
