import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { testIdentity } from "./test-auth.mjs";
const base =
  process.env.SMOKE_API_URL ??
  "https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build";
const { token } = await testIdentity(base);
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
async function api(path, body, method) {
  const r = await fetch(base + path, {
    headers,
    ...(body
      ? { method: "POST", body: JSON.stringify(body) }
      : { method: method ?? "GET" }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error);
  return data;
}
const doc = await api("/api/documents", {
  title: "Access control test",
  markdown: "# A shared page\n\nOnly invited readers can see this.",
});
const invite = await api(`/api/documents/${doc.id}/invites`, {
  role: "viewer",
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(invite.url);
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page.getByLabel("Your name").fill("Demo Reader");
  await page
    .getByLabel("Email address")
    .fill(`margin-reader-${Date.now()}@example.com`);
  await page
    .getByLabel("Password", { exact: true })
    .fill(randomBytes(24).toString("base64url"));
  await page
    .getByRole("button", { name: "Create your account", exact: true })
    .click();
  await page.getByTestId("document-editor").waitFor({ timeout: 30_000 });
  if (
    (await page
      .getByTestId("document-editor")
      .getAttribute("contenteditable")) !== "false"
  )
    throw new Error("Viewer editor is writable");
  console.log("Neon Auth invitation acceptance and viewer editor: passed");
  const members = await api(`/api/documents/${doc.id}/members`),
    reader = members.find((m) => m.role === "viewer");
  if (!reader) throw new Error("Viewer membership missing");
  await api(
    `/api/documents/${doc.id}/members/${encodeURIComponent(reader.user_id)}`,
    null,
    "DELETE",
  );
  await page
    .getByText("Document access was removed.", { exact: false })
    .waitFor({ timeout: 30_000 });
  console.log("Realtime ACL removal pauses the viewer: passed");
} finally {
  await browser.close();
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DELETE FROM documents WHERE id=$1", [doc.id]);
  await pool.end();
}
