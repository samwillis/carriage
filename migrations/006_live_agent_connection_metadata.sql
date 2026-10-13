-- The preview query engine falls back to snapshots for agent_grants because
-- migration 005 left a physically dropped column. Keep credentials in place
-- and give Realtime a fresh relation containing only connection metadata.
LOCK TABLE agent_grants IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE agent_connection_metadata (
  id uuid PRIMARY KEY REFERENCES agent_grants(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  label text NOT NULL,
  scopes text[] NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  oauth_client_id text,
  created_at timestamptz NOT NULL
);
CREATE INDEX agent_connection_metadata_account ON agent_connection_metadata(user_id);

CREATE FUNCTION sync_agent_connection_metadata() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO agent_connection_metadata(id,user_id,label,scopes,expires_at,revoked_at,oauth_client_id,created_at)
  VALUES(NEW.id,NEW.user_id,NEW.label,NEW.scopes,NEW.expires_at,NEW.revoked_at,NEW.oauth_client_id,NEW.created_at)
  ON CONFLICT(id) DO UPDATE SET
    user_id=EXCLUDED.user_id,
    label=EXCLUDED.label,
    scopes=EXCLUDED.scopes,
    expires_at=EXCLUDED.expires_at,
    revoked_at=EXCLUDED.revoked_at,
    oauth_client_id=EXCLUDED.oauth_client_id,
    created_at=EXCLUDED.created_at;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_connection_metadata_sync
AFTER INSERT OR UPDATE OF user_id,label,scopes,expires_at,revoked_at,oauth_client_id,created_at
ON agent_grants FOR EACH ROW EXECUTE FUNCTION sync_agent_connection_metadata();

INSERT INTO agent_connection_metadata(id,user_id,label,scopes,expires_at,revoked_at,oauth_client_id,created_at)
SELECT id,user_id,label,scopes,expires_at,revoked_at,oauth_client_id,created_at FROM agent_grants;
