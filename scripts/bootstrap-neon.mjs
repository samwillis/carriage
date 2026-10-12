import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const commit = "5e276fdb4114555eac89f6033b15e6ff5e9e7eb4";
const source =
  process.argv[2] ?? "https://github.com/neondatabase/neon-pkgs.git";
const checkout = resolve(".cache/neon-pkgs");
await mkdir(".cache", { recursive: true });
function run(command, args, cwd = process.cwd()) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}
run("git", ["clone", "--no-checkout", source, checkout]);
run("git", ["fetch", "origin", commit], checkout);
run("git", ["checkout", "--detach", commit], checkout);
run("corepack", ["pnpm", "install", "--frozen-lockfile"], checkout);
run(
  "corepack",
  [
    "pnpm",
    "--filter",
    "neon...",
    "--filter",
    "@neon/realtime...",
    "--filter",
    "@neon/functions...",
    "build",
  ],
  checkout,
);
run(process.execPath, ["scripts/local-sdk.mjs", checkout]);
console.log(`Preview CLI: ${checkout}/packages/cli/dist/cli.js`);
console.log("Run npm ci, then set NEON_CLI_PATH in .env.local.");
