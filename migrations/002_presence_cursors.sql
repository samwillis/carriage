ALTER TABLE document_presence ADD COLUMN IF NOT EXISTS cursor jsonb;
ALTER TABLE document_presence ADD COLUMN IF NOT EXISTS cursor_version bigint NOT NULL DEFAULT 0;
