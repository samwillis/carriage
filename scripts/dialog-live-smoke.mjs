import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { testIdentity } from "./test-auth.mjs";

const base = process.env.SMOKE_APP_URL ?? "https://carriage-neon.vercel.app";
const apiBase =
  process.env.SMOKE_API_URL ??
  "https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build";
const { token, userId } = await testIdentity(apiBase);
async function api(path, method, body) {
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
const grants = [],
  requests = [],
  errors = [];
let doc;
let targetGrant;
const incrementalGrantPages = new Set();
try {
  doc = await api("/api/documents", "POST", {
    title: "Live dialog check",
    markdown: "# Live dialogs\n\nA shared draft.",
  });
  const context = await browser.newContext({
    storageState: JSON.parse(
      await readFile(".cache/browser-session.json", "utf8"),
    ),
    viewport: { width: 1440, height: 1000 },
  });
  const a = await context.newPage(),
    b = await context.newPage();
  for (const page of [a, b]) {
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        if (!targetGrant) return;
        const source = payload.toString();
        if (!source.includes(targetGrant)) return;
        const frame = JSON.parse(source);
        const inspect = (value) => {
          if (!value || typeof value !== "object") return;
          if (
            value.op === "upsert" &&
            Array.isArray(value.values) &&
            value.values[0] === targetGrant
          )
            incrementalGrantPages.add(page);
          for (const child of Object.values(value)) inspect(child);
        };
        inspect(frame);
      }),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) =>
      requests.push({
        path: new URL(request.url()).pathname,
        method: request.method(),
      }),
    );
    await page.goto(`${base}/?doc=${doc.id}`);
    await page.getByTestId("document-editor").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Share", exact: true }).click();
  }
  const shareA = a.getByRole("dialog", { name: "Share document" });
  const shareB = b.getByRole("dialog", { name: "Share document" });
  await expect(
    shareA.getByText("People with access", { exact: true }),
  ).toBeVisible();
  const created = b.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/documents/${doc.id}/invites` &&
      r.request().method() === "POST",
  );
  await shareB.getByRole("button", { name: "Create invitation link" }).click();
  const invite = await (await created).json();
  const editorA = shareA
    .locator(".grant-row")
    .filter({ hasText: "editor invite" });
  await expect(editorA).toHaveCount(1, { timeout: 5000 });
  await expect(
    shareB.locator(".copy-box").filter({ hasText: "?invite=" }),
  ).toHaveCount(1);
  await shareA
    .locator(".grant-row")
    .filter({ hasText: "editor invite" })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(
    shareB.locator(".grant-row").filter({ hasText: "editor invite" }),
  ).toHaveCount(0, { timeout: 5000 });
  await expect(
    shareB.locator(".copy-box").filter({ hasText: "?invite=" }),
  ).toHaveCount(0);

  const member = `dialog-check:${randomUUID()}`;
  await database.query("INSERT INTO document_members VALUES($1,$2,'viewer')", [
    doc.id,
    member,
  ]);
  const memberA = shareA
    .locator(".dialog-list > div")
    .filter({ hasText: member });
  const memberB = shareB
    .locator(".dialog-list > div")
    .filter({ hasText: member });
  await expect(memberA.locator("small")).toHaveText("viewer", {
    timeout: 5000,
  });
  await database.query(
    "UPDATE document_members SET role='editor' WHERE document_id=$1 AND user_id=$2",
    [doc.id, member],
  );
  await expect(memberA.locator("small")).toHaveText("editor", {
    timeout: 5000,
  });
  await memberB.getByRole("button", { name: "Remove" }).click();
  await expect(memberA).toHaveCount(0, { timeout: 5000 });

  const expiring = await api(`/api/documents/${doc.id}/invites`, "POST", {
    role: "viewer",
  });
  const viewerA = shareA
    .locator(".grant-row")
    .filter({ hasText: "viewer invite" });
  await expect(viewerA).toHaveCount(1, { timeout: 5000 });
  await database.query(
    "UPDATE document_invites SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",
    [expiring.id],
  );
  await expect(viewerA).toHaveCount(0, { timeout: 6000 });
  console.log(
    "Two-browser invitation creation/revocation, member role/removal and timed expiry: passed.",
  );

  for (const page of [a, b])
    await page.getByRole("button", { name: "Close dialog" }).click();
  const shareRequests = () =>
    requests.filter((r) => r.path.endsWith("/sharing/live")).length;
  const shareAtClose = shareRequests();
  for (const page of [a, b])
    await page
      .getByRole("button", { name: "Agent connections", exact: true })
      .click();
  const agentA = a.getByRole("dialog", { name: "Connect agent" });
  const agentB = b.getByRole("dialog", { name: "Connect agent" });
  await agentB.getByLabel("Your app").selectOption("codex");
  const label = `Live agent ${randomUUID()}`;
  await agentB.getByLabel("Connection name").fill(label);
  const granted = b.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/grants" &&
      r.request().method() === "POST",
  );
  await agentB
    .getByRole("button", { name: "Create connection", exact: true })
    .click();
  const grant = await (await granted).json();
  targetGrant = grant.id;
  grants.push(grant.id);
  const rowA = agentA.locator(".grant-row").filter({ hasText: label });
  const rowB = agentB.locator(".grant-row").filter({ hasText: label });
  await expect(rowA).toHaveCount(1, { timeout: 5000 });
  await expect(
    agentB.getByRole("button", { name: "Copy Codex configuration" }),
  ).toBeVisible();
  const revoked = a.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/grants/${grant.id}` &&
      r.request().method() === "DELETE",
  );
  await rowA.getByRole("button", { name: "Revoke" }).click();
  const revokedResponse = await revoked;
  if (!revokedResponse.ok())
    throw new Error(
      `Connection revocation failed (${revokedResponse.status()})`,
    );
  try {
    await expect(rowB).toHaveCount(0, { timeout: 5000 });
  } catch (error) {
    const state = await database.query(
      "SELECT revoked_at IS NOT NULL AS revoked FROM agent_grants WHERE id=$1",
      [grant.id],
    );
    console.log("Revocation diagnostics:", {
      database: state.rows,
      remainingA: await rowA.count(),
      remainingB: await rowB.count(),
      alertsA: await agentA.getByRole("alert").allTextContents(),
      alertsB: await agentB.getByRole("alert").allTextContents(),
      browserErrors: errors,
    });
    throw error;
  }
  await expect(
    agentB.getByRole("button", { name: "Copy Codex configuration" }),
  ).toHaveCount(0);
  if (incrementalGrantPages.size !== 2)
    throw new Error(
      "Agent updates did not arrive incrementally in both browsers",
    );
  console.log(
    "Two-browser account connection creation/revocation and token display cleanup: passed.",
  );

  const oauthId = randomUUID(),
    oauthLabel = `OAuth record ${randomUUID()}`;
  grants.push(oauthId);
  await database.query(
    "INSERT INTO agent_grants(id,user_id,label,scopes,oauth_client_id,expires_at) VALUES($1,$2,$3,ARRAY['read'],$4,clock_timestamp()+interval '1 hour')",
    [oauthId, userId, oauthLabel, `dialog-test:${randomUUID()}`],
  );
  await expect(
    agentA.locator(".grant-row").filter({ hasText: oauthLabel }),
  ).toHaveCount(1, { timeout: 5000 });
  await a.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/grants/live",
    { timeout: 35_000 },
  );
  const renewedLabel = oauthLabel + " renewed";
  await database.query("UPDATE agent_grants SET label=$2 WHERE id=$1", [
    oauthId,
    renewedLabel,
  ]);
  await expect(
    agentA.locator(".grant-row").filter({ hasText: renewedLabel }),
  ).toHaveCount(1, { timeout: 5000 });
  await database.query(
    "UPDATE agent_grants SET expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1",
    [oauthId],
  );
  await expect(
    agentA.locator(".grant-row").filter({ hasText: renewedLabel }),
  ).toHaveCount(0, { timeout: 6000 });
  if (shareRequests() !== shareAtClose)
    throw new Error("Share query renewed after its dialog closed");
  const oldReads = requests.filter(
    (r) =>
      r.method === "GET" &&
      (r.path === "/api/grants" ||
        r.path === `/api/documents/${doc.id}/members` ||
        r.path === `/api/documents/${doc.id}/invites`),
  );
  if (oldReads.length) throw new Error("Dialogs still use REST list reads");
  if (errors.length) throw new Error(`Browser errors: ${errors.join("; ")}`);
  console.log(
    "OAuth metadata updates after renewal, timed expiry, dialog cleanup and no REST list reads: passed.",
  );
} finally {
  await browser.close();
  if (doc) await database.query("DELETE FROM documents WHERE id=$1", [doc.id]);
  if (grants.length)
    await database.query("DELETE FROM agent_grants WHERE id=ANY($1::uuid[])", [
      grants,
    ]);
  await database.end();
}
