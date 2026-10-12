import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { waitUntil } from "@neon/functions";
import { transaction, pool, type Database } from "./db";
import { type Identity, hash } from "./identity";
import { fail, AppError } from "./errors";
import {
  createDocument,
  cloneDoc,
  project,
  renderDocument,
  encodeBase64,
  decodeBase64,
} from "../shared/codec";
import {
  SCHEMA_VERSION,
  LIMITS,
  type DocumentInfo,
  type Bootstrap,
  type WriteResult,
  type ReadResult,
  editInput,
  writeInput,
  readInput,
  listInput,
  createInput,
  type CursorSelection,
} from "../shared/contracts";
import { prepareEdit, prepareWrite, readBlocks, blockCursor } from "./editing";

export class DocumentService {
  private cache = new Map<string, { head: number; bytes: Uint8Array }>();
  constructor(
    public db: Database = pool,
    public options = {
      count: 200,
      bytes: 256 * 1024,
      leaseSeconds: 30,
      maxAgeSeconds: 60,
    },
  ) {}
  async agentPresence(
    client: Pick<PoolClient, "query">,
    id: string,
    identity: Identity,
    activity: string,
    cursor: CursorSelection | null = null,
  ) {
    if (identity.kind !== "agent") return;
    // Presence follows the same live grant and membership as the operation.
    // Account agents appear only in documents they actually work on.
    await client.query(
      `INSERT INTO document_presence(document_id,session_id,user_id,label,kind,activity,cursor,cursor_version,updated_at,expires_at)
       SELECT $1,$2,$3,$4,'agent',$5,$6,1,clock_timestamp(),least(g.expires_at,$7::timestamptz,clock_timestamp()+interval '45 seconds')
       FROM document_members m JOIN agent_grants g ON g.id=$8 AND g.user_id=m.user_id
       WHERE m.document_id=$1 AND m.user_id=$3
         AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp() AND $7::timestamptz>clock_timestamp()
       ON CONFLICT(document_id,session_id) DO UPDATE SET label=excluded.label,activity=excluded.activity,
         cursor=excluded.cursor,cursor_version=document_presence.cursor_version+1,updated_at=excluded.updated_at,expires_at=excluded.expires_at`,
      [
        id,
        identity.principal,
        identity.userId,
        identity.name,
        activity,
        cursor ? JSON.stringify(cursor) : null,
        new Date(identity.expiresAt),
        identity.grantId,
      ],
    );
  }
  async authorizeAgent(
    client: Pick<PoolClient, "query">,
    identity: Identity,
    scope: string,
    locked = false,
  ) {
    const {
      rows: [grant],
    } = await client.query(
      `SELECT * FROM agent_grants WHERE id=$1 AND user_id=$2 ${locked ? "FOR SHARE" : ""}`,
      [identity.grantId, identity.userId],
    );
    const {
      rows: [clock],
    } = await client.query("SELECT clock_timestamp() AS now");
    if (identity.expiresAt <= new Date(clock.now).getTime())
      fail(401, "credential_expired", "Your credential expired.");
    if (
      !grant ||
      grant.revoked_at ||
      new Date(grant.expires_at) <= new Date(clock.now) ||
      !grant.scopes.includes(scope) ||
      !identity.scopes.includes(scope)
    )
      fail(
        403,
        "grant_denied",
        "Agent permission is missing, expired, or revoked.",
      );
    return grant;
  }
  async authorize(
    client: Pick<PoolClient, "query">,
    id: string,
    identity: Identity,
    scope = "read",
    locked = false,
  ) {
    const {
      rows: [membership],
    } = await client.query(
      `SELECT role FROM document_members WHERE document_id=$1 AND user_id=$2`,
      [id, identity.userId],
    );
    if (!membership)
      fail(404, "access_lost", "Document not found or access removed.");
    if (scope !== "read" && membership.role === "viewer")
      fail(403, "read_only", "This document is read only.");
    const {
      rows: [now],
    } = await client.query(
      "SELECT extract(epoch FROM clock_timestamp())*1000 AS now",
    );
    if (identity.expiresAt <= Number(now.now))
      fail(401, "credential_expired", "Your credential expired.");
    if (identity.kind === "agent") {
      const grant = await this.authorizeAgent(client, identity, scope, locked);
      return {
        role: membership.role,
        principal: `grant:${grant.id}`,
        grantId: grant.id,
      };
    }
    return {
      role: membership.role,
      principal: identity.principal,
      grantId: undefined,
    };
  }
  async receipt(
    client: Pick<PoolClient, "query">,
    id: string,
    principal: string,
    requestId: string,
    requestHash: string,
  ) {
    const {
      rows: [receipt],
    } = await client.query(
      "SELECT request_hash,result FROM write_receipts WHERE document_id=$1 AND principal=$2 AND request_id=$3",
      [id, principal, requestId],
    );
    if (!receipt) return null;
    if (receipt.request_hash !== requestHash)
      fail(
        409,
        "request_id_reused",
        "Request ID was already used with different input.",
      );
    return receipt.result as WriteResult;
  }
  async list(identity: Identity): Promise<DocumentInfo[]> {
    if (identity.kind !== "person")
      fail(403, "agent_route", "Use list_documents through MCP.");
    const { rows } = await this.db.query(
      `SELECT d.*,m.role FROM documents d JOIN document_members m ON m.document_id=d.id WHERE m.user_id=$1 ORDER BY d.updated_at DESC`,
      [identity.userId],
    );
    return rows;
  }
  async discover(identity: Identity, input: unknown) {
    const args = listInput.parse(input);
    await this.authorizeAgent(this.db, identity, "read");
    const { rows } = await this.db.query(
      `SELECT d.id,d.title,m.role,d.head AS revision,d.updated_at
       FROM documents d JOIN document_members m ON m.document_id=d.id
       WHERE m.user_id=$1 AND ($2::uuid IS NULL OR d.id>$2)
         AND strpos(lower(d.title),lower($3))>0
       ORDER BY d.id LIMIT $4`,
      [identity.userId, args.after ?? null, args.query, args.limit + 1],
    );
    return {
      documents: rows.slice(0, args.limit),
      next_cursor: rows.length > args.limit ? rows[args.limit - 1].id : null,
    };
  }
  async createAgent(identity: Identity, input: unknown) {
    const args = createInput.parse(input);
    return this.create(identity, args.title, args.markdown, args.request_id);
  }
  async create(
    identity: Identity,
    title: string,
    markdown: string,
    requestId?: string,
  ) {
    if (identity.kind === "agent" && !requestId)
      fail(400, "invalid_request", "Document creation requires a request ID.");
    const requestHash = hash(canonical({ title, markdown }));
    let doc: Y.Doc;
    try {
      doc = createDocument(markdown);
    } catch (error) {
      fail(
        400,
        "invalid_markdown",
        error instanceof Error ? error.message : "Unsupported Markdown.",
      );
    }
    try {
      const bytes = Y.encodeStateAsUpdate(doc);
      let rendered: string;
      try {
        rendered = renderDocument(doc);
      } catch (error) {
        fail(
          400,
          "invalid_markdown",
          error instanceof Error ? error.message : "Unsupported Markdown.",
        );
      }
      return transaction(this.db, async (client) => {
        if (identity.kind === "agent") {
          // Serialize retries before acquiring the grant lock. Revocation and
          // expiry are rechecked after waiting, before either replay or insert.
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
            [identity.principal, requestId],
          );
          await this.authorizeAgent(client, identity, "create", true);
          const {
            rows: [receipt],
          } = await client.query(
            "SELECT request_hash,result FROM document_creation_receipts WHERE principal=$1 AND request_id=$2",
            [identity.principal, requestId],
          );
          if (receipt) {
            if (receipt.request_hash !== requestHash)
              fail(
                409,
                "request_id_reused",
                "Request ID was already used with different input.",
              );
            return receipt.result as DocumentInfo;
          }
        }
        const {
          rows: [document],
        } = await client.query(
          "INSERT INTO documents(title,owner_id) VALUES($1,$2) RETURNING *",
          [title, identity.userId],
        );
        await client.query(
          "INSERT INTO document_members VALUES($1,$2,'owner')",
          [document.id, identity.userId],
        );
        await client.query(
          "INSERT INTO document_snapshots VALUES($1,0,$2,$3,$4)",
          [document.id, SCHEMA_VERSION, Buffer.from(bytes), rendered],
        );
        const result = { ...document, role: "owner" } as DocumentInfo;
        if (identity.kind === "agent")
          await this.agentPresence(client, document.id, identity, "Created");
        if (identity.kind === "agent")
          await client.query(
            "INSERT INTO document_creation_receipts(principal,request_id,request_hash,document_id,result) VALUES($1,$2,$3,$4,$5)",
            [identity.principal, requestId, requestHash, document.id, result],
          );
        return result;
      });
    } finally {
      doc.destroy();
    }
  }
  async bootstrap(id: string, identity: Identity): Promise<Bootstrap> {
    return transaction(
      this.db,
      async (client) => {
        const auth = await this.authorize(client, id, identity);
        const {
          rows: [document],
        } = await client.query("SELECT * FROM documents WHERE id=$1", [id]);
        const {
          rows: [snapshot],
        } = await client.query(
          "SELECT * FROM document_snapshots WHERE document_id=$1",
          [id],
        );
        const { rows: tail } = await client.query(
          "SELECT revision,update FROM document_updates WHERE document_id=$1",
          [id],
        );
        return {
          document: { ...document, role: auth.role },
          snapshot: encodeBase64(snapshot.state),
          tail: tail.map((row) => ({
            revision: row.revision,
            update: encodeBase64(row.update),
          })),
          markdown: snapshot.markdown,
          server_time: Date.now(),
        };
      },
      true,
    );
  }
  async load(id: string, identity: Identity, scope = "read") {
    const loaded = await transaction(
      this.db,
      async (client) => {
        const auth = await this.authorize(client, id, identity, scope);
        const {
          rows: [document],
        } = await client.query("SELECT * FROM documents WHERE id=$1", [id]);
        if (document.schema_version !== SCHEMA_VERSION)
          fail(409, "schema_mismatch", "Unsupported document schema.");
        const cached = this.cache.get(id);
        const canUse =
          cached &&
          cached.head >= document.snapshot_revision &&
          cached.head <= document.head;
        const {
          rows: [snapshot],
        } = canUse
          ? { rows: [{ state: cached.bytes, revision: cached.head }] }
          : await client.query(
              "SELECT state,revision FROM document_snapshots WHERE document_id=$1",
              [id],
            );
        const { rows: tail } = await client.query(
          "SELECT revision,update FROM document_updates WHERE document_id=$1 AND revision>$2",
          [id, snapshot.revision],
        );
        return {
          document: { ...document, role: auth.role },
          auth,
          snapshot,
          tail,
        };
      },
      true,
    );
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, new Uint8Array(loaded.snapshot.state));
      for (const row of loaded.tail)
        Y.applyUpdate(doc, new Uint8Array(row.update));
      validateCopy(doc);
      if (
        loaded.tail.length !==
        loaded.document.head - loaded.snapshot.revision
      )
        throw new Error("Committed update tail is incomplete.");
      const existing = this.cache.get(id);
      if (!existing || existing.head <= loaded.document.head) {
        this.cache.delete(id);
        this.cache.set(id, {
          head: loaded.document.head,
          bytes: Y.encodeStateAsUpdate(doc),
        });
        while (this.cache.size > 16)
          this.cache.delete(this.cache.keys().next().value!);
      }
      return { doc, document: loaded.document, auth: loaded.auth };
    } catch (error) {
      doc.destroy();
      throw error;
    }
  }
  async read(identity: Identity, input: unknown): Promise<ReadResult> {
    const args = readInput.parse(input);
    const { doc, document } = await this.load(args.document_id, identity);
    try {
      await this.agentPresence(
        this.db,
        args.document_id,
        identity,
        "Reading",
        args.mode === "blocks"
          ? blockCursor(doc, args.document_id, args.refs)
          : null,
      );
      const base = {
        document_id: args.document_id,
        title: document.title,
        revision: document.head,
        schema_version: SCHEMA_VERSION,
      };
      if (args.if_revision === document.head)
        return { ...base, unchanged: true };
      if (args.mode === "full")
        return {
          ...base,
          markdown: renderDocument(doc),
          blocks: readBlocks(doc, args.document_id),
        };
      const blocks = readBlocks(
        doc,
        args.document_id,
        args.mode === "blocks" ? args.refs : undefined,
      );
      return {
        ...base,
        blocks:
          args.mode === "outline"
            ? blocks.map((block) => ({
                ...block,
                markdown: block.type === "heading" ? block.markdown : "",
                text: block.text.slice(0, 120),
              }))
            : blocks,
      };
    } finally {
      doc.destroy();
    }
  }
  async appendBrowser(
    id: string,
    identity: Identity,
    requestId: string,
    encoded: string,
  ) {
    if (identity.kind !== "person")
      fail(
        403,
        "agent_route",
        "Agent credentials cannot upload browser updates.",
      );
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      fail(400, "invalid_update", "Invalid update encoding.");
    const bytes = decodeBase64(encoded);
    if (!bytes.length || bytes.byteLength > LIMITS.updateBytes)
      fail(413, "update_limit", "Update exceeds the supported batch limit.");
    return this.mutate(id, identity, requestId, hash(bytes), "edit", (doc) => {
      const draft = cloneDoc(doc);
      try {
        Y.applyUpdate(draft, bytes);
        if (draft.store.pendingStructs || draft.store.pendingDs)
          throw new Error("missing_dependency");
        const disposable = cloneDoc(draft);
        try {
          project(disposable);
        } finally {
          disposable.destroy();
        }
        return { draft, update: bytes, unchanged: false };
      } catch (error) {
        draft.destroy();
        if (error instanceof Error && error.message === "missing_dependency")
          fail(
            409,
            "missing_dependency",
            "Upload pending predecessor updates before retrying.",
            true,
          );
        fail(
          422,
          "invalid_update",
          error instanceof Error ? error.message : "Invalid editor update.",
        );
      }
    });
  }
  async edit(identity: Identity, input: unknown) {
    const args = editInput.parse(input);
    return this.mutate(
      args.document_id,
      identity,
      args.request_id,
      hash(canonical({ tool: "edit_document", ...args })),
      "edit",
      (doc) => prepareEdit(doc, args.document_id, args.operations),
    );
  }
  async write(identity: Identity, input: unknown) {
    const args = writeInput.parse(input);
    return this.mutate(
      args.document_id,
      identity,
      args.request_id,
      hash(canonical({ tool: "write_document", ...args })),
      "write",
      (doc, head) => {
        if (head !== args.expected_revision)
          fail(
            409,
            "revision_conflict",
            "Document changed since the full replacement was prepared.",
          );
        return prepareWrite(doc, args.markdown);
      },
      false,
    );
  }
  private async mutate(
    id: string,
    identity: Identity,
    requestId: string,
    requestHash: string,
    scope: string,
    prepare: (
      doc: Y.Doc,
      head: number,
    ) => {
      draft: Y.Doc;
      update: Uint8Array | null;
      unchanged: boolean;
      cursor?: CursorSelection | null;
    },
    retry = true,
  ) {
    const initial = await this.authorize(this.db, id, identity, scope);
    const previous = await this.receipt(
      this.db,
      id,
      initial.principal,
      requestId,
      requestHash,
    );
    if (previous) return previous;
    for (let attempt = 0; attempt < LIMITS.attempts; attempt++) {
      const loaded = await this.load(id, identity, scope);
      let prepared: ReturnType<typeof prepare> | undefined;
      try {
        prepared = prepare(loaded.doc, loaded.document.head);
        if (prepared.update && prepared.update.length > LIMITS.updateBytes)
          fail(
            413,
            "update_limit",
            "Prepared update exceeds the supported batch limit.",
          );
        const result = await transaction(this.db, async (client) => {
          const {
            rows: [document],
          } = await client.query(
            "SELECT * FROM documents WHERE id=$1 FOR UPDATE",
            [id],
          );
          if (!document) fail(404, "access_lost", "Document is unavailable.");
          const auth = await this.authorize(client, id, identity, scope, true);
          const receipt = await this.receipt(
            client,
            id,
            auth.principal,
            requestId,
            requestHash,
          );
          if (receipt) return { result: receipt, claim: null };
          if (document.head !== loaded.document.head) return null;
          const unchanged = prepared!.unchanged;
          const revision = document.head + (unchanged ? 0 : 1);
          if (!unchanged) {
            await client.query(
              "INSERT INTO document_updates(document_id,revision,mutation_id,principal,user_id,update) VALUES($1,$2,$3,$4,$5,$6)",
              [
                id,
                revision,
                requestId,
                auth.principal,
                identity.userId,
                Buffer.from(prepared!.update!),
              ],
            );
            await client.query(
              "UPDATE documents SET head=$2,pending_count=pending_count+1,pending_bytes=pending_bytes+$3,pending_since=coalesce(pending_since,clock_timestamp()),updated_at=clock_timestamp() WHERE id=$1",
              [id, revision, prepared!.update!.length],
            );
          }
          const writeResult: WriteResult = { revision, unchanged };
          await this.agentPresence(
            client,
            id,
            identity,
            "Edited",
            prepared!.cursor ?? null,
          );
          await client.query(
            "INSERT INTO write_receipts(document_id,principal,request_id,request_hash,result) VALUES($1,$2,$3,$4,$5)",
            [id, auth.principal, requestId, requestHash, writeResult],
          );
          return {
            result: writeResult,
            claim: unchanged ? null : await this.claim(client, id),
          };
        });
        if (result) {
          if (result.claim) {
            try {
              waitUntil(
                this.compact(id, result.claim).catch((error) =>
                  console.error("Compaction deferred:", String(error)),
                ),
              );
            } catch (error) {
              console.error("Compaction registration failed:", String(error));
            }
          }
          // Cache entries are immutable and versioned. Invalidate; next load catches up consistently.
          this.cache.delete(id);
          return result.result;
        }
        if (!retry)
          fail(
            409,
            "revision_conflict",
            "Document changed before the replacement committed.",
          );
      } finally {
        loaded.doc.destroy();
        prepared?.draft.destroy();
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 10 + Math.random() * 25),
      );
    }
    fail(409, "contention", "Document is busy. Retry the same request.", true);
  }
  async claim(client: PoolClient, id: string) {
    const {
      rows: [claim],
    } = await client.query(
      `UPDATE documents SET compaction_epoch=compaction_epoch+1,
      compaction_source=snapshot_revision,compaction_cutoff=head,compaction_until=clock_timestamp()+($4*interval '1 second')
      WHERE id=$1 AND (compaction_until IS NULL OR compaction_until<=clock_timestamp()) AND pending_count>0
      AND (pending_count>=$2 OR pending_bytes>=$3 OR pending_since<=clock_timestamp()-($5*interval '1 second'))
      RETURNING compaction_epoch AS epoch,compaction_source AS source,compaction_cutoff AS cutoff`,
      [
        id,
        this.options.count,
        this.options.bytes,
        this.options.leaseSeconds,
        this.options.maxAgeSeconds,
      ],
    );
    return claim ?? null;
  }
  async compact(
    id: string,
    claim: { epoch: number; source: number; cutoff: number },
    passes = 0,
  ) {
    const renew = async () => {
      await this.db.query(
        `UPDATE documents SET compaction_until=clock_timestamp()+($3*interval '1 second')
        WHERE id=$1 AND compaction_epoch=$2 AND compaction_until>clock_timestamp()`,
        [id, claim.epoch, this.options.leaseSeconds],
      );
    };
    const timer = setInterval(
      () => {
        void renew().catch((error) =>
          console.error("Compaction lease renewal:", String(error)),
        );
      },
      Math.max(100, (this.options.leaseSeconds * 1000) / 3),
    );
    timer.unref();
    try {
      await this.runCompaction(id, claim, passes);
    } finally {
      clearInterval(timer);
    }
  }
  private async runCompaction(
    id: string,
    claim: { epoch: number; source: number; cutoff: number },
    passes: number,
  ) {
    const source = await transaction(
      this.db,
      async (client) => {
        const {
          rows: [snapshot],
        } = await client.query(
          "SELECT * FROM document_snapshots WHERE document_id=$1",
          [id],
        );
        const { rows: tail } = await client.query(
          "SELECT update FROM document_updates WHERE document_id=$1 AND revision>$2 AND revision<=$3",
          [id, claim.source, claim.cutoff],
        );
        if (snapshot?.revision !== claim.source)
          throw new Error("Obsolete compaction source.");
        if (tail.length !== claim.cutoff - claim.source)
          throw new Error("Compaction tail is incomplete.");
        return { snapshot, tail };
      },
      true,
    );
    const doc = new Y.Doc();
    let state: Uint8Array, markdown: string;
    try {
      Y.applyUpdate(doc, new Uint8Array(source.snapshot.state));
      for (const row of source.tail)
        Y.applyUpdate(doc, new Uint8Array(row.update));
      markdown = renderDocument(doc);
      state = Y.encodeStateAsUpdate(doc);
    } finally {
      doc.destroy();
    }
    const next = await transaction(this.db, async (client) => {
      const {
        rows: [current],
      } = await client.query("SELECT * FROM documents WHERE id=$1 FOR UPDATE", [
        id,
      ]);
      const {
        rows: [clock],
      } = await client.query("SELECT clock_timestamp() AS now");
      if (
        !current ||
        current.compaction_epoch !== claim.epoch ||
        current.snapshot_revision !== claim.source ||
        !current.compaction_until ||
        current.compaction_until <= clock.now
      )
        return null;
      await client.query(
        "UPDATE document_snapshots SET state=$2,markdown=$3,revision=$4 WHERE document_id=$1",
        [id, Buffer.from(state), markdown, claim.cutoff],
      );
      const {
        rows: [removed],
      } = await client.query(
        `WITH incorporated AS (DELETE FROM document_updates WHERE document_id=$1 AND revision<=$2 RETURNING octet_length(update) AS bytes)
        SELECT count(*)::integer AS count,coalesce(sum(bytes),0)::bigint AS bytes FROM incorporated`,
        [id, claim.cutoff],
      );
      await client.query(
        `UPDATE documents SET snapshot_revision=$2,pending_count=pending_count-$3,pending_bytes=pending_bytes-$4,
        pending_since=(SELECT min(created_at) FROM document_updates WHERE document_id=$1),compaction_until=NULL,compaction_source=NULL,compaction_cutoff=NULL WHERE id=$1 AND compaction_epoch=$5`,
        [id, claim.cutoff, removed.count, removed.bytes, claim.epoch],
      );
      return passes < 2 ? this.claim(client, id) : null;
    });
    if (next) await this.compact(id, next, passes + 1);
  }
}
function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function validateCopy(doc: Y.Doc) {
  const copy = cloneDoc(doc);
  try {
    project(copy);
  } finally {
    copy.destroy();
  }
}
export const documents = new DocumentService();
