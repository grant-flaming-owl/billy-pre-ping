-- publisher_rtb_mappings: synced daily from Lovable portal
-- Stores per-publisher RTB routing info so the ping handler can resolve
-- the correct Ringba endpoint without hitting Lovable's Supabase.

IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'publisher_rtb_mappings')
BEGIN
  CREATE TABLE publisher_rtb_mappings (
    publisher_id    NVARCHAR(255)        NOT NULL PRIMARY KEY,
    publisher_name  NVARCHAR(255)        NULL,
    rtb_id          NVARCHAR(255)        NOT NULL,
    campaign        NVARCHAR(255)        NULL,
    campaign_id     NVARCHAR(255)        NULL,
    enabled         BIT                  NOT NULL DEFAULT 1,
    synced_at       DATETIMEOFFSET       NOT NULL DEFAULT SYSDATETIMEOFFSET(),
    last_ping_at    DATETIMEOFFSET       NULL,
    created_at      DATETIMEOFFSET       NOT NULL DEFAULT SYSDATETIMEOFFSET()
  );

  CREATE INDEX ix_rtb_mappings_rtb_id   ON publisher_rtb_mappings (rtb_id);
  CREATE INDEX ix_rtb_mappings_campaign ON publisher_rtb_mappings (campaign);
END;
