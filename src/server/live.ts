import { createRealtime, rawSql } from "@neon/realtime/server";
import { documents } from "./documents";
import { pool } from "./db";
import { type Identity } from "./identity";
import { fail } from "./errors";
import type {
  DocumentSummary,
  DocumentMember,
  DocumentInvite,
  AgentConnection,
} from "../shared/contracts";
const secret = process.env.REALTIME_SECRET ?? process.env.NEON_REALTIME_SECRET;
const realtime = secret
  ? createRealtime({
      secret,
      db: decodeURIComponent(
        new URL(process.env.DATABASE_URL!).pathname.slice(1),
      ),
    })
  : null;
function browserRealtime(identity: Identity) {
  if (!realtime)
    fail(503, "realtime_unconfigured", "Realtime is not configured.");
  if (identity.kind !== "person")
    fail(403, "agent_route", "Only browser sessions can subscribe.");
  return realtime;
}
export async function sealDocumentList(identity: Identity) {
  const realtime = browserRealtime(identity);
  // Sort in the browser: ORDER BY is not incremental in Realtime yet.
  const query = rawSql<DocumentSummary>(
    `SELECT d.id,d.title,d.updated_at,m.role FROM documents d JOIN document_members m ON m.document_id=d.id WHERE m.user_id=$1`,
    [identity.userId],
  );
  return realtime.seal({ query });
}
export async function sealSharing(id: string, identity: Identity) {
  const realtime = browserRealtime(identity);
  await documents.authorize(pool, id, identity);
  const parameters = [id, identity.userId];
  const members = rawSql<DocumentMember>(
    `SELECT t.user_id,t.role FROM document_members t JOIN document_members m ON m.document_id=t.document_id WHERE t.document_id=$1 AND m.user_id=$2`,
    parameters,
  );
  const invites = rawSql<DocumentInvite>(
    `SELECT t.id,t.role,t.expires_at,t.revoked_at FROM document_invites t JOIN document_members m ON m.document_id=t.document_id WHERE t.document_id=$1 AND m.user_id=$2 AND m.role='owner'`,
    parameters,
  );
  const [memberQuery, inviteQuery] = await Promise.all(
    [members, invites].map((query) => realtime.seal({ query })),
  );
  return {
    members: memberQuery,
    invites: inviteQuery,
    server_time: Date.now(),
  };
}
export async function sealAgentConnections(identity: Identity) {
  const realtime = browserRealtime(identity);
  const query = rawSql<AgentConnection>(
    `SELECT id,label,scopes,expires_at,revoked_at,oauth_client_id,created_at FROM agent_connection_metadata WHERE user_id=$1`,
    [identity.userId],
  );
  return { grants: await realtime.seal({ query }), server_time: Date.now() };
}
export async function sealDocument(id: string, identity: Identity) {
  const realtime = browserRealtime(identity);
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
    `SELECT t.session_id,t.user_id,t.label,t.kind,t.activity,t.expires_at,t.cursor,t.cursor_version,t.updated_at FROM document_presence t JOIN document_members m ON ${predicate} WHERE t.document_id=$1`,
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
