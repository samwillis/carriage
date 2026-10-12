import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Pool } from "pg";
import { applyAppMigrations } from "../scripts/app-migrations";
import { randomUUID } from "node:crypto";
import { DocumentService } from "../src/server/documents";
import { transaction } from "../src/server/db";
import type { Identity } from "../src/server/identity";
import * as Y from "yjs";
import { decodeBase64, encodeBase64 } from "../src/shared/codec";
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)(
  "Postgres write and compaction transactions",
  { timeout: 30_000 },
  () => {
    const db = new Pool({ connectionString: url, max: 8 });
    const service = new DocumentService(db, {
      count: 1000,
      bytes: 1e9,
      leaseSeconds: 30,
      maxAgeSeconds: 1e6,
    });
    const user: Identity = {
      principal: "user:test",
      userId: "test",
      name: "Test",
      kind: "person",
      expiresAt: Date.now() + 3600_000,
      scopes: ["read", "edit", "write"],
    };
    const ids: string[] = [],
      grants: string[] = [];
    async function create() {
      const d = await service.create(user, "Test", "One.\n\nTwo.\n\nMiddle.");
      ids.push(d.id);
      return d.id;
    }
    async function change(
      id: string,
      index: number,
      text: string,
      request_id = randomUUID(),
    ) {
      const read = await service.read(user, { document_id: id });
      const block = read.blocks![index];
      return service.edit(user, {
        document_id: id,
        request_id,
        operations: [
          {
            type: "replace_block",
            ref: block.ref,
            expected_hash: block.hash,
            markdown: text,
          },
        ],
      });
    }
    beforeAll(async () => {
      await applyAppMigrations(db);
    });
    afterAll(async () => {
      await db.query("DELETE FROM documents WHERE id=ANY($1::uuid[])", [ids]);
      await db.query("DELETE FROM agent_grants WHERE id=ANY($1::uuid[])", [
        grants,
      ]);
      await db.end();
    });
    it("stores durable receipts including no-ops, rejecting reused IDs", async () => {
      const id = await create(),
        request_id = randomUUID();
      const read = await service.read(user, { document_id: id });
      const block = read.blocks![0];
      const args = {
        document_id: id,
        request_id,
        operations: [
          {
            type: "replace_block",
            ref: block.ref,
            expected_hash: block.hash,
            markdown: "Changed.",
          },
        ],
      };
      expect(await service.edit(user, args)).toEqual({
        revision: 1,
        unchanged: false,
      });
      expect(await service.edit(user, args)).toEqual({
        revision: 1,
        unchanged: false,
      });
      await expect(
        service.edit(user, {
          ...args,
          operations: [{ ...args.operations[0], markdown: "Different." }],
        }),
      ).rejects.toMatchObject({ code: "request_id_reused" });
      const noop = await service.write(user, {
        document_id: id,
        request_id: randomUUID(),
        expected_revision: 1,
        markdown: "Changed.\n\nTwo.\n\nMiddle.",
      });
      expect(noop).toEqual({ revision: 1, unchanged: true });
      await expect(
        service.write(user, {
          document_id: id,
          request_id: randomUUID(),
          expected_revision: 0,
          markdown: "Oops",
        }),
      ).rejects.toMatchObject({ code: "revision_conflict" });
    });
    it("retries simultaneous edits of separate blocks without replacing the middle", async () => {
      const id = await create();
      const read = await service.read(user, { document_id: id });
      const results = await Promise.all(
        [0, 1].map((i) =>
          service.edit(user, {
            document_id: id,
            request_id: randomUUID(),
            operations: [
              {
                type: "replace_text",
                ref: read.blocks![i].ref,
                expected_hash: read.blocks![i].hash,
                expected_text: i === 0 ? "One" : "Two",
                replacement: i === 0 ? "First" : "Second",
                occurrence: 0,
              },
            ],
          }),
        ),
      );
      expect(results.map((r) => r.revision).sort()).toEqual([1, 2]);
      expect((await service.read(user, { document_id: id })).markdown).toBe(
        "First.\n\nSecond.\n\nMiddle.\n",
      );
    });
    it("compacts only a fixed cutoff while further appends proceed", async () => {
      const id = await create();
      await change(id, 0, "First.");
      await change(id, 1, "Second.");
      const compacting = new DocumentService(db, {
        count: 2,
        bytes: 1e9,
        leaseSeconds: 30,
        maxAgeSeconds: 1e6,
      });
      const claim = await transaction(db, (c) => compacting.claim(c, id));
      expect(claim.cutoff).toBe(2);
      await change(id, 2, "Still writable.");
      await compacting.compact(id, claim);
      const boot = await service.bootstrap(id, user);
      expect(boot.document.head).toBe(3);
      expect(boot.document.snapshot_revision).toBe(2);
      expect(boot.tail.map((t) => t.revision)).toEqual([3]);
      expect(boot.document.pending_count).toBe(1);
      expect(
        (await service.read(user, { document_id: id })).markdown,
      ).toContain("Still writable.");
    });
    it("fences expired workers and retains their original tail", async () => {
      const id = await create();
      await change(id, 0, "First.");
      const compacting = new DocumentService(db, {
        count: 1,
        bytes: 1e9,
        leaseSeconds: 30,
        maxAgeSeconds: 1e6,
      });
      const old = await transaction(db, (c) => compacting.claim(c, id));
      await db.query(
        "UPDATE documents SET compaction_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [id],
      );
      const newer = await transaction(db, (c) => compacting.claim(c, id));
      await compacting.compact(id, old);
      const afterOld = await service.bootstrap(id, user);
      expect(afterOld.document.snapshot_revision).toBe(0);
      expect(afterOld.tail).toHaveLength(1);
      await compacting.compact(id, newer);
      expect(
        (await service.bootstrap(id, user)).document.snapshot_revision,
      ).toBe(1);
    });
    it("rechecks grant revocation and membership on each tool call", async () => {
      const id = await create();
      const grant = (
        await db.query(
          "INSERT INTO agent_grants(user_id,label,scopes,expires_at) VALUES('test','Agent',ARRAY['read','edit'],clock_timestamp()+interval '1 hour') RETURNING id",
        )
      ).rows[0];
      grants.push(grant.id);
      const agent: Identity = {
        ...user,
        kind: "agent",
        grantId: grant.id,
        principal: `grant:${grant.id}`,
        scopes: ["read", "edit"],
      };
      expect((await service.read(agent, { document_id: id })).revision).toBe(0);
      await db.query(
        "UPDATE agent_grants SET revoked_at=clock_timestamp() WHERE id=$1",
        [grant.id],
      );
      await expect(
        service.read(agent, { document_id: id }),
      ).rejects.toMatchObject({ code: "grant_denied" });
      await db.query("DELETE FROM document_members WHERE document_id=$1", [id]);
      await expect(
        service.read(user, { document_id: id }),
      ).rejects.toMatchObject({ code: "access_lost" });
    });
    it("rejects causally incomplete updates and accepts identical retries after predecessors", async () => {
      const id = await create(),
        boot = await service.bootstrap(id, user),
        doc = new Y.Doc();
      Y.applyUpdate(doc, decodeBase64(boot.snapshot));
      const text = (
        doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement
      ).get(0) as Y.XmlText;
      const updates: Uint8Array[] = [];
      doc.on("update", (u) => updates.push(u));
      text.insert(text.length, " a");
      text.insert(text.length, " b");
      const request = randomUUID();
      await expect(
        service.appendBrowser(id, user, request, encodeBase64(updates[1])),
      ).rejects.toMatchObject({ code: "missing_dependency" });
      await service.appendBrowser(
        id,
        user,
        randomUUID(),
        encodeBase64(updates[0]),
      );
      expect(
        await service.appendBrowser(
          id,
          user,
          request,
          encodeBase64(updates[1]),
        ),
      ).toMatchObject({ revision: 2 });
      expect(
        (await service.read(user, { document_id: id })).markdown,
      ).toContain("One. a b");
      doc.destroy();
    });
    it("rejects a credential that expires while waiting for the grant lock", async () => {
      const id = await create(),
        block = (await service.read(user, { document_id: id })).blocks![0];
      const grant = (
        await db.query(
          "INSERT INTO agent_grants(user_id,label,scopes,expires_at) VALUES('test','Agent',ARRAY['read','edit'],clock_timestamp()+interval '1 hour') RETURNING id",
        )
      ).rows[0];
      grants.push(grant.id);
      const lock = await db.connect();
      let attempt: Promise<any> | undefined;
      try {
        await lock.query("BEGIN");
        const pid = (await lock.query("SELECT pg_backend_pid() AS pid")).rows[0]
          .pid;
        await lock.query("SELECT id FROM agent_grants WHERE id=$1 FOR UPDATE", [
          grant.id,
        ]);
        const agent: Identity = {
          ...user,
          kind: "agent",
          grantId: grant.id,
          principal: `grant:${grant.id}`,
          scopes: ["read", "edit"],
          // Allow the initial network round trips to reach the held grant lock.
          expiresAt: Date.now() + 10_000,
        };
        attempt = service
          .edit(agent, {
            document_id: id,
            request_id: randomUUID(),
            operations: [
              {
                type: "replace_block",
                ref: block.ref,
                expected_hash: block.hash,
                markdown: "Expired write.",
              },
            ],
          })
          .catch((error) => error);
        let waiting = false;
        for (let i = 0; i < 50 && !waiting; i++) {
          waiting = !!(
            await db.query(
              "SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))",
              [pid],
            )
          ).rowCount;
          if (!waiting) await new Promise((r) => setTimeout(r, 5));
        }
        expect(waiting).toBe(true);
        await new Promise((r) =>
          setTimeout(r, Math.max(0, agent.expiresAt - Date.now()) + 100),
        );
        await lock.query("ROLLBACK");
        expect(await attempt).toMatchObject({ code: "credential_expired" });
        expect((await service.read(user, { document_id: id })).revision).toBe(
          0,
        );
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
        if (attempt) await attempt;
      }
    });
  },
);
