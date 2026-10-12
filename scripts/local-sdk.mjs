import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const app = fileURLToPath(new URL("../", import.meta.url));
const checkout = process.argv[2] ?? process.env.NEON_PKGS_CHECKOUT;
if (!checkout) {
  throw new Error(
    "Pass a built neon-pkgs checkout: npm run sdk:local -- /path/to/neon-pkgs",
  );
}
const manifest = JSON.parse(
  await readFile(resolve(app, "package.json"), "utf8"),
);
const destination = resolve(app, ".sdk");
await mkdir(destination, { recursive: true });
const lockPath = resolve(app, "package-lock.json");
const lock = process.argv.includes("--refresh-integrity")
  ? JSON.parse(await readFile(lockPath, "utf8"))
  : null;

for (const [name, dependency] of Object.entries({
  ...manifest.dependencies,
  ...manifest.devDependencies,
})) {
  if (!name.startsWith("@neon/") || !dependency.startsWith("file:.sdk/")) {
    continue;
  }
  const source = resolve(checkout, "packages", name.slice("@neon/".length));
  await readFile(resolve(source, "dist/index.js"));
  const temporary = await mkdtemp(resolve(tmpdir(), "neon-realtime-sdk-"));
  try {
    const metadata = JSON.parse(
      await readFile(resolve(source, "package.json"), "utf8"),
    );
    // Only pack distribution files. Source-only build scripts cannot run from
    // the tarball, and workspace dev dependencies do not belong in the app.
    delete metadata.scripts;
    delete metadata.devDependencies;
    // npm cannot resolve pnpm workspace ranges from a standalone tarball.
    // The app installs its matching local packages from the same checkout.
    for (const section of ["dependencies", "peerDependencies"]) {
      for (const [peer, version] of Object.entries(metadata[section] ?? {})) {
        if (!version.startsWith("workspace:")) continue;
        const peerManifest = JSON.parse(
          await readFile(
            resolve(
              checkout,
              "packages",
              peer.slice("@neon/".length),
              "package.json",
            ),
            "utf8",
          ),
        );
        metadata[section][peer] = peerManifest.version;
      }
    }
    await writeFile(
      resolve(temporary, "package.json"),
      JSON.stringify(metadata, null, 2),
    );
    for (const file of metadata.files) {
      if (file === "package.json") continue;
      await cp(resolve(source, file), resolve(temporary, file), {
        recursive: true,
      });
    }
    // Tarballs let React and ORM peers resolve from the app, avoiding duplicate
    // React instances caused by symlinks into the SDK checkout.
    const output = execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      {
        cwd: temporary,
        encoding: "utf8",
      },
    );
    const [{ filename }] = JSON.parse(output);
    await rename(
      resolve(destination, filename),
      resolve(app, dependency.slice("file:".length)),
    );
    if (lock) {
      const entry = lock.packages[`node_modules/${name}`];
      if (entry?.version !== metadata.version || entry?.resolved !== dependency)
        throw new Error(`${name} does not match the locked SDK version.`);
      // These tarballs are generated from a pinned source checkout. Build
      // artifacts vary across platforms, so hash the actual local artifact.
      // Registry package versions and integrity hashes remain untouched.
      entry.integrity =
        "sha512-" +
        createHash("sha512")
          .update(
            await readFile(resolve(app, dependency.slice("file:".length))),
          )
          .digest("base64");
    }
    console.log(`Prepared ${name}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (lock) await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n");
console.log("Run npm ci to install the local SDK packages.");
