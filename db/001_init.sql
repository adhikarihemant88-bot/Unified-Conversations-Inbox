CREATE TABLE IF NOT EXISTS locations (
  id text PRIMARY KEY,
  name text NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id),
  token_hash text NOT NULL UNIQUE,
  UNIQUE (location_id, id)
);
CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id),
  name text,
  UNIQUE (location_id, id)
);
CREATE TABLE IF NOT EXISTS contact_identities (
  location_id text NOT NULL,
  contact_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('phone', 'email')),
  value text NOT NULL,
  PRIMARY KEY (location_id, kind, value),
  FOREIGN KEY (location_id, contact_id) REFERENCES contacts(location_id, id)
);
CREATE INDEX IF NOT EXISTS identities_contact ON contact_identities(location_id, contact_id);
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY,
  location_id text NOT NULL,
  contact_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  assigned_to text,
  unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  last_message_at timestamptz,
  last_message_id uuid,
  last_message_preview text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (location_id, contact_id),
  UNIQUE (location_id, id),
  FOREIGN KEY (location_id, contact_id) REFERENCES contacts(location_id, id),
  FOREIGN KEY (location_id, assigned_to) REFERENCES agents(location_id, id)
);
CREATE INDEX IF NOT EXISTS conversations_latest ON conversations(location_id, last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS conversations_filtered ON conversations(location_id, status, assigned_to, last_message_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  location_id text NOT NULL,
  conversation_id uuid NOT NULL,
  provider_message_id text NOT NULL UNIQUE,
  channel text NOT NULL CHECK (channel IN ('sms', 'whatsapp', 'email')),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sender text NOT NULL,
  recipient text NOT NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed')),
  sent_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (location_id, conversation_id) REFERENCES conversations(location_id, id)
);
CREATE INDEX IF NOT EXISTS messages_history ON messages(location_id, conversation_id, sent_at, id);
CREATE INDEX IF NOT EXISTS messages_search ON messages USING gin(to_tsvector('simple', body));
CREATE TABLE IF NOT EXISTS provider_states (
  provider_message_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed')),
  event_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS send_jobs (
  message_id uuid PRIMARY KEY REFERENCES messages(id),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done')),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS jobs_due ON send_jobs(next_attempt_at) WHERE state = 'pending';
CREATE TABLE IF NOT EXISTS inbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS events_location ON inbox_events(location_id, id);
CREATE TABLE IF NOT EXISTS pagination_snapshots (
  id uuid PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id),
  scope text NOT NULL,
  items jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '15 minutes'
);
CREATE INDEX IF NOT EXISTS snapshots_expiry ON pagination_snapshots(expires_at);
