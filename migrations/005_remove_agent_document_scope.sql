-- Deploy account-only handlers before applying this migration. Dropping the
-- column also removes its foreign key, transitional check and dependent indexes.
ALTER TABLE agent_grants DROP COLUMN document_id;
CREATE INDEX IF NOT EXISTS agent_grants_account ON agent_grants (user_id);
CREATE INDEX IF NOT EXISTS agent_grants_oauth ON agent_grants (oauth_client_id,user_id);
