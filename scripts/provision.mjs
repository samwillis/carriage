import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
const cli = process.env.NEON_CLI_PATH;
if (!cli) throw new Error("Set NEON_CLI_PATH to the built Realtime CLI entry.");
if (!process.env.NEON_ORG_ID)
  throw new Error("Set NEON_ORG_ID to the selected staging organization.");
const env = {
  ...process.env,
  NEON_API_HOST: "https://console-stage.neon.build/api/v2",
  NEON_OAUTH_HOST: "https://oauth2-stage.neon.build",
};
function api(path, body) {
  const r = spawnSync(
    process.execPath,
    [
      cli,
      "--profile",
      "staging",
      "api",
      path,
      ...(body ? ["-X", "POST", "-d", JSON.stringify(body)] : []),
    ],
    { env, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (r.status !== 0) throw new Error(r.stderr || "Neon API failed");
  return JSON.parse(r.stdout);
}
await mkdir(".cache", { recursive: true });
let created;
try {
  created = JSON.parse(await readFile(".cache/project.json", "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  created = api("/projects", {
    project: {
      name: "collaborative-markdown",
      org_id: process.env.NEON_ORG_ID,
      region_id: "aws-us-east-2",
      pg_version: 18,
      realtime: {
        allowed_origins: ["http://localhost:5180", "http://127.0.0.1:5180"],
      },
    },
  });
  await writeFile(".cache/project.json", JSON.stringify(created), {
    mode: 0o600,
  });
}
const project = created.project.id;
const branch =
  created.branch?.id ??
  api(`/projects/${project}/branches`).branches.find((b) => b.default).id;
let realtime;
for (let i = 0; i < 30; i++) {
  realtime = api(`/projects/${project}/branches/${branch}/realtime`);
  if (realtime.enabled && !realtime.pending) break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!realtime.enabled || realtime.pending)
  throw new Error("Realtime is not ready; rerun to resume.");
const secret = api(`/projects/${project}/branches/${branch}/realtime/secret`);
const database = created.connection_uris?.[0]?.connection_uri;
if (!database) throw new Error("Create response missing connection URI.");
let existing = "";
try {
  existing = await readFile(".env.local", "utf8");
} catch {}
const values = {
  NEON_PROFILE: "staging",
  NEON_CLI_PATH: cli,
  NEON_API_HOST: env.NEON_API_HOST,
  NEON_OAUTH_HOST: env.NEON_OAUTH_HOST,
  DATABASE_URL: database,
  DATABASE_URL_UNPOOLED: database,
  NEON_REALTIME_SECRET: secret.secret,
  NEON_REALTIME_URL: realtime.invocation_url.replace(/^https:/, "wss:"),
  VITE_NEON_REALTIME_URL: realtime.invocation_url.replace(/^https:/, "wss:"),
};
const keys = new Set(Object.keys(values));
const remaining = existing
  .split("\n")
  .filter((line) => !keys.has(line.match(/^([A-Z_0-9]+)=/)?.[1]));
await writeFile(
  ".env.local",
  remaining.join("\n").trim() +
    "\n" +
    Object.entries(values)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n") +
    "\n",
  { mode: 0o600 },
);
await writeFile(
  ".cache/infrastructure.json",
  JSON.stringify(
    {
      environment: "staging",
      api_host: env.NEON_API_HOST,
      project,
      branch,
      region: "aws-us-east-2",
      org: process.env.NEON_ORG_ID,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      environment: "staging",
      project,
      branch,
      realtime_ready: true,
      credentials: "stored in gitignored .env.local",
    },
    null,
    2,
  ),
);
