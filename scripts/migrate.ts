import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { getMigrations } from "better-auth/db/migration";
import { applyAppMigrations } from "./app-migrations";
const { values } = parseArgs({ options: { through: { type: "string" } } });
const database = new Pool({
  connectionString:
    process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
  max: 1,
});
try {
  await applyAppMigrations(database, {
    through: values.through,
    onApplied: (name) => console.log(`Applied ${name}`),
  });
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
