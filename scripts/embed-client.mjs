import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
if (process.argv.includes("--ensure")) {
  try {
    await readFile(".cache/frontend.ts");
  } catch {
    await mkdir(".cache", { recursive: true });
    await writeFile(
      ".cache/frontend.ts",
      `export const frontend:Record<string,{type:string;body:string}>={'/':{type:'text/html',body:'Run npm run build to prepare the public frontend.'}};\n`,
    );
  }
  process.exit(0);
}
const entries = {
  "/": {
    type: "text/html; charset=utf-8",
    body: await readFile("dist/index.html", "utf8"),
  },
};
for (const name of await readdir("dist/assets")) {
  if (!/\.(js|css)$/.test(name)) continue;
  entries[`/assets/${name}`] = {
    type: name.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8",
    body: await readFile(`dist/assets/${name}`, "utf8"),
  };
}
await mkdir(".cache", { recursive: true });
await writeFile(
  ".cache/frontend.ts",
  `export const frontend:Record<string,{type:string;body:string}>=${JSON.stringify(entries)};\n`,
);
console.log(
  `Embedded ${Object.keys(entries).length} frontend files for Neon Functions.`,
);
