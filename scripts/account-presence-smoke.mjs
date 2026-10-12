import { chromium, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { testIdentity } from "./test-auth.mjs";

const base = process.env.SMOKE_APP_URL ?? "https://carriage-neon.vercel.app";
const apiBase =
  process.env.SMOKE_API_URL ??
  "https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build";
const { token } = await testIdentity(apiBase);
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
async function api(path, body) {
  const response = await fetch(apiBase + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`API failed (${response.status}) at ${path}`);
  return response.json();
}
const database = new Pool({ connectionString: process.env.DATABASE_URL });
const browser = await chromium.launch({ headless: true });
const client = new Client({ name: "account-presence-test", version: "1.0" });
let doc, grant;
try {
  doc = await api("/api/documents", {
    title: "Agent presence check",
    markdown: "# A shared draft\n\nOne paragraph.\n\nAnother paragraph.",
  });
  grant = await api("/api/grants", {
    label: "Writing agent",
    scopes: ["read", "edit", "create"],
    days: 1,
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${apiBase}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
    }),
  );
  async function tool(name, args) {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(`Tool failed: ${name}`);
    return JSON.parse(result.content[0].text);
  }
  const context = await browser.newContext({
    storageState: JSON.parse(
      await readFile(".cache/browser-session.json", "utf8"),
    ),
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/?doc=${doc.id}`);
  await page.getByTestId("document-editor").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await page
    .getByRole("button", { name: "Copy document ID", exact: true })
    .waitFor();
  await expect(
    page.getByRole("dialog").getByText(doc.id, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Copy document agent prompt" })
    .waitFor();
  await page.getByRole("button", { name: "Set up MCP connection" }).click();
  await page.getByRole("dialog", { name: "Connect agent" }).waitFor();
  await page.getByLabel("Your app").selectOption("codex");
  await expect(
    page.getByText("Read, edit + create documents", { exact: true }),
  ).toBeAttached();
  await page.getByRole("button", { name: "Close dialog" }).click();
  console.log(
    "Share document ID, document prompt and account MCP setup: passed",
  );

  const read = await tool("read_document", { document_id: doc.id });
  const block = read.blocks.find((block) => block.text === "One paragraph.");
  await tool("read_document", {
    document_id: doc.id,
    mode: "blocks",
    refs: [block.ref],
  });
  await expect(page.locator(".ProseMirror-yjs-selection")).toHaveText(
    "One paragraph.",
    { timeout: 20_000 },
  );
  await expect(page.locator(".ProseMirror-yjs-cursor")).toContainText(
    "Writing agent · agent",
  );
  await tool("edit_document", {
    document_id: doc.id,
    request_id: randomUUID(),
    operations: [
      {
        type: "replace_text",
        ref: block.ref,
        expected_hash: block.hash,
        expected_text: "One",
        replacement: "First",
        occurrence: 0,
      },
    ],
  });
  await expect(page.locator(".ProseMirror-yjs-selection")).toHaveText("First", {
    timeout: 20_000,
  });
  await page.locator(".presence-panel summary").click();
  await expect(page.getByRole("group", { name: "Participants" })).toContainText(
    "Writing agent",
  );
  await expect(page.getByRole("group", { name: "Participants" })).toContainText(
    "Edited just now",
  );
  await page.screenshot({
    path: ".cache/account-presence-desktop.png",
    animations: "disabled",
  });
  await page
    .getByRole("button", { name: "Find Writing agent in document" })
    .click();
  await expect(page.locator(".presence-panel")).not.toHaveAttribute("open", "");
  console.log(
    "Live agent read/edit selections, activity and jump-to-selection: passed",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".presence-panel summary").click();
  await page.screenshot({
    path: ".cache/account-presence-mobile.png",
    animations: "disabled",
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (overflow) throw new Error("Presence popover overflows mobile viewport");
  const synthetic = randomUUID();
  await api(`/api/documents/${doc.id}/presence`, {
    session_id: synthetic,
    activity: "Viewing",
    sequence: 1,
  });
  await api(`/api/documents/${doc.id}/presence`, {
    session_id: synthetic,
    activity: "Idle",
    sequence: 3,
    leaving: true,
  });
  await api(`/api/documents/${doc.id}/presence`, {
    session_id: synthetic,
    activity: "Viewing",
    sequence: 2,
  });
  const stored = (
    await database.query(
      "SELECT expires_at<clock_timestamp() AS expired,cursor_version FROM document_presence WHERE document_id=$1 AND session_id=$2",
      [doc.id, synthetic],
    )
  ).rows[0];
  if (!stored.expired || Number(stored.cursor_version) !== 3)
    throw new Error("An older heartbeat restored a departed session");
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
  console.log("Mobile presence and sequenced departure tombstone: passed");
} finally {
  await browser.close();
  await client.close();
  if (doc) await database.query("DELETE FROM documents WHERE id=$1", [doc.id]);
  if (grant)
    await database.query("DELETE FROM agent_grants WHERE id=$1", [grant.id]);
  await database.end();
}
