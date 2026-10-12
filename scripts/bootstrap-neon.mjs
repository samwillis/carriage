import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
const commit = "5e276fdb4114555eac89f6033b15e6ff5e9e7eb4";
const sdkOnly = process.argv.includes("--sdk-only");
const source =
  process.argv.slice(2).find((arg) => arg !== "--sdk-only") ??
  "https://github.com/neondatabase/neon-pkgs.git";
const checkout = resolve(".cache/neon-pkgs");
await mkdir(".cache", { recursive: true });
function run(command, args, cwd = process.cwd()) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}
const exists = await stat(resolve(checkout, ".git")).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
if (!exists) {
  // Vercel restores nested node_modules without the enclosing Git checkout.
  // Restore Git metadata beside those dependencies, then check out the source.
  const temporary = await mkdtemp(resolve(tmpdir(), "carriage-sdk-"));
  try {
    run("git", ["clone", "--no-checkout", source, temporary]);
    await mkdir(checkout, { recursive: true });
    await cp(resolve(temporary, ".git"), resolve(checkout, ".git"), {
      recursive: true,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
// Reuse Vercel's build cache but always build the pinned SDK revision.
run("git", ["fetch", "origin", commit], checkout);
run("git", ["checkout", "--detach", commit], checkout);
run(
  "corepack",
  [
    "pnpm",
    "install",
    "--frozen-lockfile",
    ...(sdkOnly ? ["--ignore-scripts"] : []),
  ],
  checkout,
);
run(
  "corepack",
  [
    "pnpm",
    "--filter",
    ...(sdkOnly
      ? ["@neon/sdk...", "--filter", "@neon/config..."]
      : ["neon..."]),
    "--filter",
    "@neon/realtime...",
    "--filter",
    "@neon/functions...",
    "build",
  ],
  checkout,
);
run(process.execPath, [
  "scripts/local-sdk.mjs",
  checkout,
  "--refresh-integrity",
]);
if (!sdkOnly) {
  console.log(`Preview CLI: ${checkout}/packages/cli/dist/cli.js`);
  console.log("Run npm ci, then set NEON_CLI_PATH in .env.local.");
}
