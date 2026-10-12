import { readFile, readdir, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
const database = new Pool({
  connectionString:
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
  max: 1,
});
try {
  await database.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
  );
  for (const name of (await readdir("migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    if (
      (
        await database.query(
          "SELECT name FROM schema_migrations WHERE name=$1",
          [name],
        )
      ).rowCount
    )
      continue;
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(`migrations/${name}`, "utf8"));
      await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [
        name,
      ]);
      await client.query("COMMIT");
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  const { oauth } = await import("../src/server/oauth");
  const migration = await getMigrations({ ...oauth.options, database });
  const sql = await migration.compileMigrations();
  if (sql) await writeFile(".cache/oauth-schema.sql", sql);
  await migration.runMigrations();
  await oauth.$context;
  console.log("OAuth provider schema is current.");
  const { pool } = await import("../src/server/db");
  await pool.end();
} finally {
  await database.end();
}
