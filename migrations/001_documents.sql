CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  owner_id text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  head integer NOT NULL DEFAULT 0,
  snapshot_revision integer NOT NULL DEFAULT 0,
  pending_count integer NOT NULL DEFAULT 0,
  pending_bytes bigint NOT NULL DEFAULT 0,
  pending_since timestamptz,
  compaction_epoch integer NOT NULL DEFAULT 0,
  compaction_source integer,
  compaction_cutoff integer,
  compaction_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS document_members (
  document_id uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (document_id,user_id)
);
CREATE TABLE IF NOT EXISTS document_snapshots (
  document_id uuid PRIMARY KEY REFERENCES documents ON DELETE CASCADE,
  revision integer NOT NULL,
  schema_version integer NOT NULL,
  state bytea NOT NULL,
  markdown text NOT NULL
);
CREATE TABLE IF NOT EXISTS document_updates (
  document_id uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
  revision integer NOT NULL,
  mutation_id uuid NOT NULL,
  principal text NOT NULL,
  user_id text NOT NULL,
  update bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (document_id,revision)
);
CREATE TABLE IF NOT EXISTS write_receipts (
  document_id uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
  principal text NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (document_id,principal,request_id)
);
CREATE TABLE IF NOT EXISTS document_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('editor','viewer')),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS agent_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
  user_id text NOT NULL,
  label text NOT NULL,
  token_hash text UNIQUE,
  oauth_client_id text,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS agent_grants_oauth ON agent_grants (oauth_client_id,user_id,document_id);
CREATE TABLE IF NOT EXISTS document_presence (
  document_id uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
  session_id text NOT NULL,
  user_id text NOT NULL,
  label text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('person','agent')),
  activity text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (document_id,session_id)
);
CREATE TABLE IF NOT EXISTS oauth_login_tickets (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL,
  name text NOT NULL,
  grant_id uuid NOT NULL REFERENCES agent_grants ON DELETE CASCADE,
  oauth_query text NOT NULL,
  expires_at timestamptz NOT NULL
);
