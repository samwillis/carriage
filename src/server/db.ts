import { Pool, type PoolClient } from "pg";
import { attachDatabasePool } from "@neon/functions";
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
attachDatabasePool(pool);
export type Database = Pick<Pool, "query" | "connect">;
export async function transaction<T>(
  db: Database,
  callback: (client: PoolClient) => Promise<T>,
  repeatable = false,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query(
      repeatable ? "BEGIN ISOLATION LEVEL REPEATABLE READ" : "BEGIN",
    );
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
