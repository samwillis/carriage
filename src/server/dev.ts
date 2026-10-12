import { serve } from "@hono/node-server";
import app from "./app";
import { pool } from "./db";
const server = serve(
  { fetch: app.fetch, port: 3080, hostname: "127.0.0.1" },
  () => console.log("Carriage API: http://localhost:3080"),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () =>
    server.close(() => void pool.end().finally(() => process.exit())),
  );
