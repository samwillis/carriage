import { readFile, readdir } from "node:fs/promises";
import type { Pool } from "pg";

export async function applyAppMigrations(
  database: Pick<Pool, "connect">,
  options: { through?: string; onApplied?: (name: string) => void } = {},
) {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (options.through && !names.includes(options.through))
    throw new Error(`Unknown migration: ${options.through}`);
  const client = await database.connect();
  try {
    // Serialize deploys and integration-test setup through the same ledger.
    await client.query(
      "SELECT pg_advisory_lock(hashtext('carriage:migrations'))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT clock_timestamp())",
    );
    for (const name of names) {
      if (options.through && name > options.through) break;
      if (
        (
          await client.query(
            "SELECT name FROM schema_migrations WHERE name=$1",
            [name],
          )
        ).rowCount
      )
        continue;
      try {
        await client.query("BEGIN");
        await client.query(await readFile(new URL(name, directory), "utf8"));
        await client.query("INSERT INTO schema_migrations(name) VALUES($1)", [
          name,
        ]);
        await client.query("COMMIT");
        options.onApplied?.(name);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock(hashtext('carriage:migrations'))",
      );
    } finally {
      client.release();
    }
  }
}
