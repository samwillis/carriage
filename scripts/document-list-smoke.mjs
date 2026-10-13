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
const { token, userId } = await testIdentity(apiBase);
async function api(path, method = "GET", body) {
  const response = await fetch(apiBase + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`API failed (${response.status}) at ${path}`);
  return response.json();
}
const database = new Pool({ connectionString: process.env.DATABASE_URL });
const browser = await chromium.launch({ headless: true });
const client = new Client({ name: "sidebar-check", version: "1.0" });
const ids = [];
let grant;
try {
  grant = await api("/api/grants", "POST", {
    label: "Sidebar check",
    scopes: ["read", "create"],
    days: 1,
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${apiBase}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
    }),
  );
  const context = await browser.newContext({
    storageState: JSON.parse(
      await readFile(".cache/browser-session.json", "utf8"),
    ),
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) =>
    requests.push(new URL(request.url()).pathname),
  );
  const { url } = JSON.parse(
    await readFile(".cache/test-document.json", "utf8"),
  );
  await page.goto(base + new URL(url).search);
  await page.getByTestId("document-editor").waitFor({ timeout: 30_000 });
  const sidebar = page.locator(".sidebar nav");
  await expect(sidebar.locator(".document-link").first()).toBeVisible();
  const activeUrl = page.url();
  const title = `Sidebar ${randomUUID()}`;
  const start = Date.now();
  const result = await client.callTool({
    name: "create_document",
    arguments: {
      request_id: randomUUID(),
      title,
      markdown: "# Sidebar check",
    },
  });
  if (result.isError) throw new Error("MCP creation failed");
  const doc = JSON.parse(result.content[0].text);
  const documentId = doc.document_id;
  if (!documentId) throw new Error("MCP creation did not return a document ID");
  ids.push(documentId);
  await expect(
    sidebar.getByRole("button", { name: title, exact: true }),
  ).toBeVisible({ timeout: 5000 });
  console.log(
    `Agent-created document appeared in ${Date.now() - start} ms (including MCP request).`,
  );
  const renamed = title + " renamed";
  await api(`/api/documents/${documentId}`, "PATCH", { title: renamed });
  await expect(
    sidebar.getByRole("button", { name: renamed, exact: true }),
  ).toBeVisible({ timeout: 5000 });
  await expect(
    sidebar.getByRole("button", { name: title, exact: true }),
  ).toHaveCount(0);
  expect(page.url()).toBe(activeUrl);

  const privateTitle = `Private ${randomUUID()}`,
    owner = `sidebar-test:${randomUUID()}`;
  const privateDoc = (
    await database.query(
      "INSERT INTO documents(title,owner_id) VALUES($1,$2) RETURNING id",
      [privateTitle, owner],
    )
  ).rows[0];
  ids.push(privateDoc.id);
  await database.query("INSERT INTO document_members VALUES($1,$2,'owner')", [
    privateDoc.id,
    owner,
  ]);
  await expect(
    sidebar.getByRole("button", { name: privateTitle, exact: true }),
  ).toHaveCount(0);
  await database.query("INSERT INTO document_members VALUES($1,$2,'editor')", [
    privateDoc.id,
    userId,
  ]);
  await expect(
    sidebar.getByRole("button", { name: privateTitle, exact: true }),
  ).toBeVisible({ timeout: 5000 });
  await database.query(
    "UPDATE document_members SET role='viewer' WHERE document_id=$1 AND user_id=$2",
    [privateDoc.id, userId],
  );
  await expect(
    sidebar.getByRole("button", { name: privateTitle + " View", exact: true }),
  ).toBeVisible({ timeout: 5000 });
  await database.query(
    "DELETE FROM document_members WHERE document_id=$1 AND user_id=$2",
    [privateDoc.id, userId],
  );
  await expect(
    sidebar.getByRole("button", { name: privateTitle + " View", exact: true }),
  ).toHaveCount(0, { timeout: 5000 });
  console.log("Live rename, sharing, role change and access removal: passed.");

  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/documents/live",
    { timeout: 35_000 },
  );
  const renewedTitle = title + " after renewal";
  await api(`/api/documents/${documentId}`, "PATCH", { title: renewedTitle });
  await expect(
    sidebar.getByRole("button", { name: renewedTitle, exact: true }),
  ).toBeVisible({ timeout: 5000 });
  if (requests.includes("/api/documents"))
    throw new Error("Sidebar still fetched the REST document list");
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
  console.log(
    "Updates after capability renewal, with no document-list polling: passed.",
  );
} finally {
  await browser.close();
  await client.close();
  if (ids.length)
    await database.query("DELETE FROM documents WHERE id=ANY($1::uuid[])", [
      ids,
    ]);
  if (grant)
    await database.query("DELETE FROM agent_grants WHERE id=$1", [grant.id]);
  await database.end();
}
