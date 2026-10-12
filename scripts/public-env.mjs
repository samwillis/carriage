import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
const values = parseEnv(await readFile(".env.local", "utf8"));
const production = process.argv[2]
  ? parseEnv(await readFile(process.argv[2], "utf8"))
  : values;
const development = {
  VITE_NEON_AUTH_BASE_URL: values.NEON_AUTH_BASE_URL,
  VITE_NEON_REALTIME_URL: values.NEON_REALTIME_URL,
  VITE_API_BASE_URL: values.PUBLIC_API_BASE_URL ?? "",
};
await writeFile(
  ".env.development.local",
  Object.entries(development)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
await writeFile(
  ".env.production.local",
  Object.entries({
    VITE_NEON_AUTH_BASE_URL: production.NEON_AUTH_BASE_URL,
    VITE_NEON_REALTIME_URL: production.NEON_REALTIME_URL,
    VITE_API_BASE_URL:
      production.PUBLIC_API_BASE_URL || production.API_BASE_URL,
  })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
console.log("Public browser configuration written (no server secrets).");
