import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
const values = parseEnv(await readFile(".env.local", "utf8"));
const publicValues = {
  VITE_NEON_AUTH_BASE_URL: values.NEON_AUTH_BASE_URL,
  VITE_NEON_REALTIME_URL: values.NEON_REALTIME_URL,
  VITE_API_BASE_URL: values.PUBLIC_API_BASE_URL ?? "",
};
await writeFile(
  ".env.development.local",
  Object.entries(publicValues)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
await writeFile(
  ".env.production.local",
  Object.entries({ ...publicValues, VITE_API_BASE_URL: "" })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
console.log("Public browser configuration written (no server secrets).");
