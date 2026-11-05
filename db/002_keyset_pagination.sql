-- Cursor (keyset) pagination replaces stored result snapshots.
-- Brings a database created from an earlier 001_init.sql to the current schema;
-- a fresh database already has it, so every statement is a no-op there.
DROP TABLE IF EXISTS pagination_snapshots;

DROP INDEX IF EXISTS conversations_latest;
DROP INDEX IF EXISTS conversations_filtered;
CREATE INDEX IF NOT EXISTS conversations_by_activity
  ON conversations(location_id, last_message_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS conversations_by_status_activity
  ON conversations(location_id, status, last_message_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS conversations_by_assignee_activity
  ON conversations(location_id, assigned_to, last_message_at DESC NULLS LAST, id DESC);
