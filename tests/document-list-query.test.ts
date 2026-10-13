import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Identity } from "../src/server/identity";

vi.mock("@neon/realtime/server", () => ({
  createRealtime: () => ({ seal: async ({ query }: any) => query }),
  rawSql: (sql: string, parameters: unknown[]) => ({ sql, parameters }),
}));
vi.mock("../src/server/db", () => ({ pool: {} }));
vi.mock("../src/server/documents", () => ({
  documents: { authorize: async () => ({ role: "owner" }) },
}));
const database = new PGlite();
let sealDocumentList: typeof import("../src/server/live").sealDocumentList;
let sealSharing: typeof import("../src/server/live").sealSharing;
let sealAgentConnections: typeof import("../src/server/live").sealAgentConnections;
const person: Identity = {
  kind: "person",
  userId: "writer",
  name: "Writer",
  principal: "user:writer",
  scopes: ["read", "edit"],
  expiresAt: Date.now() + 3600_000,
};
beforeAll(async () => {
  vi.stubEnv("REALTIME_SECRET", "test-secret");
  vi.stubEnv("DATABASE_URL", "postgres://localhost/test");
  ({ sealDocumentList, sealSharing, sealAgentConnections } =
    await import("../src/server/live"));
  await database.exec(`
    CREATE TABLE documents(id text PRIMARY KEY,title text,updated_at timestamptz);
    CREATE TABLE document_members(document_id text,user_id text,role text);
    CREATE TABLE document_invites(id text,document_id text,role text,expires_at timestamptz,revoked_at timestamptz,token_hash text);
    CREATE TABLE agent_connection_metadata(id text,user_id text,label text,scopes text[],expires_at timestamptz,revoked_at timestamptz,oauth_client_id text,created_at timestamptz);
    INSERT INTO documents VALUES('own','Own',now()),('shared','Shared',now()),('private','Private',now());
    INSERT INTO document_members VALUES('own','writer','owner'),('shared','writer','viewer'),('shared','other','owner'),('private','other','owner');
  `);
});
afterAll(async () => {
  await database.close();
  vi.unstubAllEnvs();
});
describe("document list query authorization", () => {
  it("includes only the caller's memberships and reflects role changes and revocation", async () => {
    const query = (await sealDocumentList(person)) as unknown as {
      sql: string;
      parameters: unknown[];
    };
    const read = async () =>
      (
        await database.query<{ id: string; role: string }>(
          query.sql,
          query.parameters,
        )
      ).rows;
    expect(await read()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "own", role: "owner" }),
        expect.objectContaining({ id: "shared", role: "viewer" }),
      ]),
    );
    expect(await read()).toHaveLength(2);
    await database.exec(
      "UPDATE document_members SET role='editor' WHERE document_id='shared' AND user_id='writer'",
    );
    expect(await read()).toContainEqual(
      expect.objectContaining({ id: "shared", role: "editor" }),
    );
    await database.exec(
      "DELETE FROM document_members WHERE document_id='shared' AND user_id='writer'",
    );
    expect(await read()).toEqual([expect.objectContaining({ id: "own" })]);
  });
  it("rejects agent credentials on the browser subscription route", async () => {
    await expect(
      sealDocumentList({ ...person, kind: "agent" }),
    ).rejects.toMatchObject({ status: 403, code: "agent_route" });
  });
  it("keeps sharing queries authorized after ownership changes and access removal", async () => {
    await database.exec(`
      INSERT INTO documents VALUES('sharing','Sharing',now());
      INSERT INTO document_members VALUES('sharing','writer','owner'),('sharing','reader','viewer');
      INSERT INTO document_invites VALUES('invite','sharing','editor',now()+interval '1 day',NULL,'private-hash');
    `);
    const owner = await sealSharing("sharing", person);
    const reader = await sealSharing("sharing", {
      ...person,
      userId: "reader",
    });
    async function read(sealed: unknown) {
      const query = sealed as { sql: string; parameters: unknown[] };
      return (await database.query<any>(query.sql, query.parameters)).rows;
    }
    expect(await read(owner.members)).toHaveLength(2);
    const invites = await read(owner.invites);
    expect(invites).toHaveLength(1);
    expect(Object.keys(invites[0]).sort()).toEqual([
      "expires_at",
      "id",
      "revoked_at",
      "role",
    ]);
    expect(await read(reader.invites)).toEqual([]);
    await database.exec(
      "UPDATE document_members SET role='viewer' WHERE document_id='sharing' AND user_id='writer'",
    );
    expect(await read(owner.invites)).toEqual([]);
    await database.exec(
      "DELETE FROM document_members WHERE document_id='sharing' AND user_id='writer'",
    );
    expect(await read(owner.members)).toEqual([]);
  });
  it("restricts connection metadata to its account and excludes token hashes", async () => {
    await database.exec(`
      INSERT INTO agent_connection_metadata VALUES('mine','writer','Mine',ARRAY['read'],now()+interval '1 day',NULL,NULL,now());
      INSERT INTO agent_connection_metadata VALUES('other','other','Other',ARRAY['read'],now()+interval '1 day',NULL,NULL,now());
    `);
    const sealed = await sealAgentConnections(person);
    const query = sealed.grants as unknown as {
      sql: string;
      parameters: unknown[];
    };
    const rows = (await database.query<any>(query.sql, query.parameters)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("mine");
    expect(Object.keys(rows[0]).sort()).toEqual([
      "created_at",
      "expires_at",
      "id",
      "label",
      "oauth_client_id",
      "revoked_at",
      "scopes",
    ]);
    await expect(
      sealAgentConnections({ ...person, kind: "agent" }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      sealSharing("sharing", { ...person, kind: "agent" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
