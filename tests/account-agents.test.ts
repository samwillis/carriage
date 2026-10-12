import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { applyAppMigrations } from "../scripts/app-migrations";
import * as Y from "yjs";
import { relativePositionToAbsolutePosition } from "y-prosemirror";
import { DocumentService } from "../src/server/documents";
import type { Identity } from "../src/server/identity";
import { project } from "../src/shared/codec";

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "account agent permissions and creation",
  { timeout: 30_000 },
  () => {
    const db = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 5,
    });
    const service = new DocumentService(db);
    const user: Identity = {
      principal: `user:${randomUUID()}`,
      userId: `account-test:${randomUUID()}`,
      name: "Writer",
      kind: "person",
      expiresAt: Date.now() + 3600_000,
      scopes: ["read", "edit", "write"],
    };
    const ids: string[] = [],
      grants: string[] = [];
    async function create(owner = user, title = "Account test") {
      const doc = await service.create(
        owner,
        title,
        "# Title\n\nOne paragraph.\n\nAnother paragraph.",
      );
      ids.push(doc.id);
      return doc;
    }
    async function agent(scopes = ["read", "edit", "write", "create"]) {
      const {
        rows: [grant],
      } = await db.query(
        "INSERT INTO agent_grants(user_id,label,scopes,expires_at) VALUES($1,'Test agent',$2,clock_timestamp()+interval '1 hour') RETURNING id",
        [user.userId, scopes],
      );
      grants.push(grant.id);
      return {
        ...user,
        kind: "agent",
        principal: `grant:${grant.id}`,
        grantId: grant.id,
        scopes,
      } as Identity;
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
    it("discovers owned and shared documents, filters and paginates without exposing others", async () => {
      const own = await create(user, "Find alpha"),
        other = await create(
          { ...user, userId: `other:${randomUUID()}` },
          "Find beta",
        );
      const hidden = await create(
        { ...user, userId: `hidden:${randomUUID()}` },
        "Find hidden",
      );
      await db.query("INSERT INTO document_members VALUES($1,$2,'viewer')", [
        other.id,
        user.userId,
      ]);
      const identity = await agent();
      const first = await service.discover(identity, {
        query: "Find",
        limit: 1,
      });
      expect(first.documents).toHaveLength(1);
      expect(first.next_cursor).toBe(first.documents[0].id);
      const second = await service.discover(identity, {
        query: "Find",
        limit: 1,
        after: first.next_cursor,
      });
      expect(
        new Set([...first.documents, ...second.documents].map((d) => d.id)),
      ).toEqual(new Set([own.id, other.id]));
      expect(second.next_cursor).toBeNull();
      expect(first.documents[0]).not.toHaveProperty("markdown");
      await expect(
        service.read(identity, { document_id: hidden.id }),
      ).rejects.toMatchObject({ code: "access_lost" });
      await expect(
        service.write(identity, {
          document_id: other.id,
          request_id: randomUUID(),
          expected_revision: 0,
          markdown: "Changed",
        }),
      ).rejects.toMatchObject({ code: "read_only" });
    });
    it("creates once across concurrent retries and owns an editable document", async () => {
      const identity = await agent(),
        input = {
          request_id: randomUUID(),
          title: "Created by agent",
          markdown: "# New\n\nDraft.",
        };
      const [first, retried] = await Promise.all([
        service.createAgent(identity, input),
        service.createAgent(identity, input),
      ]);
      ids.push(first.id);
      expect(first.id).toBe(retried.id);
      await expect(
        service.createAgent(identity, {
          request_id: randomUUID(),
          title: "Invalid content",
          markdown: "<script>bad</script>",
        }),
      ).rejects.toMatchObject({ code: "invalid_markdown", retryable: false });
      expect(
        (
          await db.query("SELECT owner_id FROM documents WHERE id=$1", [
            first.id,
          ])
        ).rows[0].owner_id,
      ).toBe(user.userId);
      const created = await service.read(identity, { document_id: first.id });
      expect(created.markdown).toContain("Draft.");
      await expect(
        service.createAgent(identity, { ...input, title: "Changed input" }),
      ).rejects.toMatchObject({ code: "request_id_reused" });
      expect(
        await service.write(identity, {
          document_id: first.id,
          request_id: randomUUID(),
          expected_revision: 0,
          markdown: "Updated.",
        }),
      ).toMatchObject({ revision: 1 });
    });
    it("checks live membership and revocation across all tools, including creation retries", async () => {
      const document = await create(),
        identity = await agent();
      const input = { request_id: randomUUID(), title: "Revoke test" };
      const made = await service.createAgent(identity, input);
      ids.push(made.id);
      await db.query(
        "DELETE FROM document_members WHERE document_id=$1 AND user_id=$2",
        [document.id, user.userId],
      );
      await expect(
        service.read(identity, { document_id: document.id }),
      ).rejects.toMatchObject({ code: "access_lost" });
      expect(
        (await service.discover(identity, {})).documents.map((d) => d.id),
      ).not.toContain(document.id);
      await db.query(
        "UPDATE agent_grants SET revoked_at=clock_timestamp() WHERE id=$1",
        [identity.grantId],
      );
      await expect(service.discover(identity, {})).rejects.toMatchObject({
        code: "grant_denied",
      });
      await expect(service.createAgent(identity, input)).rejects.toMatchObject({
        code: "grant_denied",
      });
    });
    it("enforces narrower token and grant scopes", async () => {
      const first = await create();
      const account = await agent();
      await expect(
        service.write(
          { ...account, scopes: ["read"] },
          {
            document_id: first.id,
            request_id: randomUUID(),
            expected_revision: 0,
            markdown: "Denied",
          },
        ),
      ).rejects.toMatchObject({ code: "grant_denied" });
      const readOnly = await agent(["read"]);
      await expect(
        service.createAgent(readOnly, {
          request_id: randomUUID(),
          title: "Denied",
        }),
      ).rejects.toMatchObject({ code: "grant_denied" });
    });
    it("records agent selections against committed text without appending presence to the document", async () => {
      const document = await create(),
        identity = await agent();
      const read = await service.read(identity, { document_id: document.id });
      const target = read.blocks!.find((b) => b.text === "One paragraph.")!;
      await service.read(identity, {
        document_id: document.id,
        mode: "blocks",
        refs: [target.ref],
      });
      let presence = (
        await db.query(
          "SELECT * FROM document_presence WHERE document_id=$1 AND session_id=$2",
          [document.id, identity.principal],
        )
      ).rows[0];
      expect(presence.activity).toBe("Reading");
      expect(presence.cursor).toBeTruthy();
      expect((await service.bootstrap(document.id, user)).document.head).toBe(
        0,
      );
      await service.edit(identity, {
        document_id: document.id,
        request_id: randomUUID(),
        operations: [
          {
            type: "replace_text",
            ref: target.ref,
            expected_hash: target.hash,
            expected_text: "One",
            replacement: "Updated",
            occurrence: 0,
          },
        ],
      });
      presence = (
        await db.query(
          "SELECT * FROM document_presence WHERE document_id=$1 AND session_id=$2",
          [document.id, identity.principal],
        )
      ).rows[0];
      expect(presence.activity).toBe("Edited");
      const loaded = await service.load(document.id, user);
      try {
        const projection = project(loaded.doc),
          root = loaded.doc.getXmlFragment("prosemirror");
        const from = relativePositionToAbsolutePosition(
          loaded.doc,
          root,
          Y.createRelativePositionFromJSON(presence.cursor.anchor),
          projection.meta.mapping,
        )!;
        const to = relativePositionToAbsolutePosition(
          loaded.doc,
          root,
          Y.createRelativePositionFromJSON(presence.cursor.head),
          projection.meta.mapping,
        )!;
        expect(projection.doc.textBetween(from, to)).toBe("Updated");
        expect(loaded.document.head).toBe(1);
      } finally {
        loaded.doc.destroy();
      }
    });
  },
);
