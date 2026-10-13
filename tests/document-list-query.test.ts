import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import type { Identity } from "../src/server/identity";

vi.mock("@neon/realtime/server", () => ({
  createRealtime: () => ({ seal: async ({ query }: any) => query }),
  rawSql: (sql: string, parameters: unknown[]) => ({ sql, parameters }),
}));
vi.mock("../src/server/db", () => ({ pool: {} }));
vi.mock("../src/server/documents", () => ({ documents: {} }));
const database = new PGlite();
let sealDocumentList: typeof import("../src/server/live").sealDocumentList;
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
  ({ sealDocumentList } = await import("../src/server/live"));
  await database.exec(`
    CREATE TABLE documents(id text PRIMARY KEY,title text,updated_at timestamptz);
    CREATE TABLE document_members(document_id text,user_id text,role text);
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
});
