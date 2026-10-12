import { spawnSync } from "node:child_process";
if (process.env.NEON_PROFILE && process.env.NEON_PROFILE !== "staging")
  throw new Error("This preview demo is pinned to Neon staging.");
const cli = process.env.NEON_CLI_PATH;
const command = cli ? process.execPath : "neon";
const args = [
  ...(cli ? [cli] : []),
  "--profile",
  "staging",
  ...process.argv.slice(2),
];
const result = spawnSync(command, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    NEON_API_HOST: "https://console-stage.neon.build/api/v2",
    NEON_OAUTH_HOST: "https://oauth2-stage.neon.build",
  },
});
process.exit(result.status ?? 1);
