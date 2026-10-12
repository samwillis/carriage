-- NULL means an explicitly approved account connection. Existing grants keep
-- their document ID and are never widened by this migration.
ALTER TABLE agent_grants ALTER COLUMN document_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS agent_grants_account ON agent_grants (user_id) WHERE document_id IS NULL;
CREATE TABLE IF NOT EXISTS document_creation_receipts (
  principal text NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  document_id uuid NOT NULL REFERENCES documents ON DELETE CASCADE,
  result jsonb NOT NULL,
  PRIMARY KEY (principal, request_id)
);
ALTER TABLE document_presence ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();
