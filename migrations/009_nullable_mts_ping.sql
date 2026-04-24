-- Allow mts_id and ping_id to be NULL in sequence_triggers
-- SMS sends from /rtb/sms endpoint don't always have an associated MTS or ping record
ALTER TABLE sequence_triggers ALTER COLUMN mts_id UNIQUEIDENTIFIER NULL;
ALTER TABLE sequence_triggers ALTER COLUMN ping_id UNIQUEIDENTIFIER NULL;
