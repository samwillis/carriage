import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("backfills safe metadata and keeps grant changes atomic, including deletion", async () => {
  const db = new PGlite();
  try {
    for (const name of [
      "001_documents.sql",
      "002_presence_cursors.sql",
      "003_account_agents.sql",
      "004_remove_document_connections.sql",
      "005_remove_agent_document_scope.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../migrations/${name}`, import.meta.url),
          "utf8",
        ),
      );
    const id = "00000000-0000-4000-8000-000000000001";
    await db.query(
      "INSERT INTO agent_grants(id,user_id,label,token_hash,scopes,expires_at) VALUES($1,'writer','Agent','private-hash',ARRAY['read'],now()+interval '1 day')",
      [id],
    );
    await db.exec("BEGIN");
    await db.exec(
      await readFile(
        new URL(
          "../migrations/006_live_agent_connection_metadata.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec("COMMIT");
    const read = async () =>
      (
        await db.query<any>(
          "SELECT * FROM agent_connection_metadata WHERE id=$1",
          [id],
        )
      ).rows[0];
    expect(await read()).toMatchObject({
      user_id: "writer",
      label: "Agent",
      scopes: ["read"],
    });
    expect(Object.keys(await read()).sort()).toEqual([
      "created_at",
      "expires_at",
      "id",
      "label",
      "oauth_client_id",
      "revoked_at",
      "scopes",
      "user_id",
    ]);
    expect(
      (
        await db.query(
          "SELECT attname FROM pg_attribute WHERE attrelid='agent_connection_metadata'::regclass AND attisdropped",
        )
      ).rows,
    ).toEqual([]);
    await db.exec("BEGIN");
    await db.query("UPDATE agent_grants SET label='Rolled back' WHERE id=$1", [
      id,
    ]);
    expect((await read()).label).toBe("Rolled back");
    await db.exec("ROLLBACK");
    expect((await read()).label).toBe("Agent");
    await db.query(
      "UPDATE agent_grants SET user_id='other',label='Updated',scopes=ARRAY['read','edit'],expires_at=now()+interval '2 days',revoked_at=now(),oauth_client_id='oauth-client' WHERE id=$1",
      [id],
    );
    const changed = await read();
    expect(changed).toMatchObject({
      user_id: "other",
      label: "Updated",
      scopes: ["read", "edit"],
      oauth_client_id: "oauth-client",
    });
    expect(changed.revoked_at).toBeTruthy();
    expect(changed.expires_at).toEqual(
      (
        await db.query<any>("SELECT expires_at FROM agent_grants WHERE id=$1", [
          id,
        ])
      ).rows[0].expires_at,
    );
    await db.query("DELETE FROM agent_grants WHERE id=$1", [id]);
    expect(await read()).toBeUndefined();
    const oauth = "00000000-0000-4000-8000-000000000002";
    await db.query(
      "INSERT INTO agent_grants(id,user_id,label,scopes,oauth_client_id,expires_at) VALUES($1,'writer','OAuth',ARRAY['read'],'oauth-client',now()+interval '1 hour')",
      [oauth],
    );
    expect(
      (await db.query("SELECT id,label FROM agent_connection_metadata")).rows,
    ).toEqual([{ id: oauth, label: "OAuth" }]);
  } finally {
    await db.close();
  }
});
