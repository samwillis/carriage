-- Apply this before deploying account-only handlers. Block the old write route
-- from recreating document grants while retaining its nullable column temporarily.
LOCK TABLE agent_grants IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE retired_document_agent_grants ON COMMIT DROP AS
  SELECT id FROM agent_grants WHERE document_id IS NOT NULL;

DELETE FROM document_presence
  WHERE session_id IN (SELECT 'grant:' || id::text FROM retired_document_agent_grants);

-- A new installation may not have the OAuth provider tables yet.
DO $$
DECLARE oauth_table text;
BEGIN
  FOREACH oauth_table IN ARRAY ARRAY['oauth_access_tokens','oauth_refresh_tokens','oauth_consents'] LOOP
    IF to_regclass('public.' || oauth_table) IS NOT NULL THEN
      EXECUTE format('DELETE FROM %I WHERE "referenceId" IN (SELECT id::text FROM retired_document_agent_grants)', oauth_table);
    END IF;
  END LOOP;
  IF to_regclass('public.oauth_sessions') IS NOT NULL THEN
    DELETE FROM oauth_sessions
      WHERE "grantId" IN (SELECT id::text FROM retired_document_agent_grants);
  END IF;
  IF to_regclass('public.oauth_verifications') IS NOT NULL THEN
    DELETE FROM oauth_verifications
      WHERE CASE WHEN value IS JSON OBJECT THEN value::jsonb->>'referenceId' END
        IN (SELECT id::text FROM retired_document_agent_grants);
  END IF;
END $$;

-- Login tickets cascade with the deleted grants. Document edits and their
-- durable receipts remain in the document history.
DELETE FROM agent_grants WHERE id IN (SELECT id FROM retired_document_agent_grants);
ALTER TABLE agent_grants ADD CONSTRAINT agent_grants_account_only CHECK (document_id IS NULL);
