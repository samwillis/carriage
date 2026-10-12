import { createRealtime, rawSql } from "@neon/realtime/server";
import { documents } from "./documents";
import { pool } from "./db";
import { type Identity } from "./identity";
import { fail } from "./errors";
const secret = process.env.REALTIME_SECRET ?? process.env.NEON_REALTIME_SECRET;
const realtime = secret
  ? createRealtime({
      secret,
      db: decodeURIComponent(
        new URL(process.env.DATABASE_URL!).pathname.slice(1),
      ),
    })
  : null;
export async function sealDocument(id: string, identity: Identity) {
  if (!realtime)
    fail(503, "realtime_unconfigured", "Realtime is not configured.");
  if (identity.kind !== "person")
    fail(403, "agent_route", "Only browser sessions can subscribe.");
  await documents.authorize(pool, id, identity);
  const parameters = [id, identity.userId];
  const predicate = "m.document_id=t.document_id AND m.user_id=$2";
  const snapshots = rawSql<{
    state: Uint8Array;
    revision: number;
    schema_version: number;
  }>(
    `SELECT t.state,t.revision,t.schema_version FROM document_snapshots t JOIN document_members m ON ${predicate} WHERE t.document_id=$1`,
    parameters,
  );
  const updates = rawSql<{ update: Uint8Array; revision: number }>(
    `SELECT t.update,t.revision FROM document_updates t JOIN document_members m ON ${predicate} WHERE t.document_id=$1`,
    parameters,
  );
  const metadata = rawSql(
    `SELECT d.id,d.title,d.head,d.snapshot_revision,d.pending_count,d.pending_bytes,d.compaction_until,m.role FROM documents d JOIN document_members m ON m.document_id=d.id WHERE d.id=$1 AND m.user_id=$2`,
    parameters,
  );
  const presence = rawSql(
    `SELECT t.session_id,t.user_id,t.label,t.kind,t.activity,t.expires_at FROM document_presence t JOIN document_members m ON ${predicate} WHERE t.document_id=$1`,
    parameters,
  );
  const [snapshotQuery, updateQuery, metadataQuery, presenceQuery] =
    await Promise.all(
      [snapshots, updates, metadata, presence].map((query) =>
        realtime.seal({ query }),
      ),
    );
  return {
    snapshots: snapshotQuery,
    updates: updateQuery,
    metadata: metadataQuery,
    presence: presenceQuery,
  };
}
