import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { describe, it, expect } from "vitest";

const account = "00000000-0000-4000-8000-000000000001";
const retired = "00000000-0000-4000-8000-000000000002";
const document = "00000000-0000-4000-8000-000000000003";
async function migration(db: PGlite, name: string) {
  await db.exec(
    await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
  );
}
async function setup() {
  const db = new PGlite();
  for (const name of [
    "001_documents.sql",
    "002_presence_cursors.sql",
    "003_account_agents.sql",
  ])
    await migration(db, name);
  await db.query(
    "INSERT INTO documents(id,title,owner_id) VALUES($1,'Draft','writer')",
    [document],
  );
  await db.query(
    "INSERT INTO agent_grants(id,document_id,user_id,label,scopes,expires_at) VALUES($1,NULL,'writer','Account',ARRAY['read','edit','create'],clock_timestamp()+interval '1 day'),($2,$3,'writer','Retired',ARRAY['read'],clock_timestamp()+interval '1 day')",
    [account, retired, document],
  );
  for (const id of [account, retired]) {
    await db.query(
      "INSERT INTO oauth_login_tickets VALUES($1,'writer','Writer',$2,'query',clock_timestamp()+interval '1 hour')",
      [id, id],
    );
    await db.query(
      "INSERT INTO document_presence(document_id,session_id,user_id,label,kind,activity,expires_at) VALUES($1,$2,'writer','Agent','agent','Reading',clock_timestamp()+interval '1 hour')",
      [document, `grant:${id}`],
    );
  }
  await db.query(
    "INSERT INTO document_updates(document_id,revision,mutation_id,principal,user_id,update) VALUES($1,1,$2,$3,'writer','\\x01')",
    [document, retired, `grant:${retired}`],
  );
  return db;
}

describe("account-only connection migrations", () => {
  it("removes retired credentials and presence, preserving account connections and edits", async () => {
    const db = await setup();
    try {
      for (const table of [
        "oauth_access_tokens",
        "oauth_refresh_tokens",
        "oauth_consents",
      ]) {
        await db.exec(`CREATE TABLE ${table}("referenceId" text)`);
        await db.query(`INSERT INTO ${table} VALUES($1),($2)`, [
          account,
          retired,
        ]);
      }
      await db.exec(
        'CREATE TABLE oauth_sessions("grantId" text); CREATE TABLE oauth_verifications(value text)',
      );
      await db.query("INSERT INTO oauth_sessions VALUES($1),($2)", [
        account,
        retired,
      ]);
      await db.query(
        "INSERT INTO oauth_verifications VALUES($1),($2),('not-json')",
        [
          JSON.stringify({ referenceId: account }),
          JSON.stringify({ referenceId: retired }),
        ],
      );
      await db.exec("BEGIN");
      await migration(db, "004_remove_document_connections.sql");
      await db.exec("COMMIT");
      expect((await db.query("SELECT id FROM agent_grants")).rows).toEqual([
        { id: account },
      ]);
      for (const table of [
        "oauth_access_tokens",
        "oauth_refresh_tokens",
        "oauth_consents",
      ])
        expect(
          (await db.query(`SELECT "referenceId" FROM ${table}`)).rows,
        ).toEqual([{ referenceId: account }]);
      expect(
        (await db.query('SELECT "grantId" FROM oauth_sessions')).rows,
      ).toEqual([{ grantId: account }]);
      expect(
        (await db.query("SELECT value FROM oauth_verifications")).rows,
      ).toEqual([
        { value: JSON.stringify({ referenceId: account }) },
        { value: "not-json" },
      ]);
      expect(
        (await db.query("SELECT grant_id FROM oauth_login_tickets")).rows,
      ).toEqual([{ grant_id: account }]);
      expect(
        (await db.query("SELECT session_id FROM document_presence")).rows,
      ).toEqual([{ session_id: `grant:${account}` }]);
      expect(
        (await db.query("SELECT principal FROM document_updates")).rows,
      ).toEqual([{ principal: `grant:${retired}` }]);
      await expect(
        db.query(
          "INSERT INTO agent_grants(document_id,user_id,label,scopes,expires_at) VALUES($1,'writer','Denied',ARRAY['read'],clock_timestamp()+interval '1 hour')",
          [document],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await migration(db, "005_remove_agent_document_scope.sql");
      expect(
        (
          await db.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='agent_grants' AND column_name='document_id'",
          )
        ).rows,
      ).toEqual([]);
      // Deleting a document no longer deletes an account connection.
      await db.query("DELETE FROM documents WHERE id=$1", [document]);
      expect((await db.query("SELECT id FROM agent_grants")).rows).toEqual([
        { id: account },
      ]);
    } finally {
      await db.close();
    }
  });
  it("supports fresh installs before OAuth provider tables exist", async () => {
    const db = await setup();
    try {
      await db.exec("BEGIN");
      await migration(db, "004_remove_document_connections.sql");
      await migration(db, "005_remove_agent_document_scope.sql");
      await db.exec("COMMIT");
      expect((await db.query("SELECT id FROM agent_grants")).rows).toEqual([
        { id: account },
      ]);
    } finally {
      await db.close();
    }
  });
});
