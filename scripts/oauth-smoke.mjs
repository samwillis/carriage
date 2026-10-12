import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { testIdentity } from "./test-auth.mjs";
const base =
  process.env.SMOKE_API_URL ??
  "https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build";
const clientName = process.env.OAUTH_REUSE_SESSION
  ? "Margin OAuth smoke (second client)"
  : "Margin OAuth smoke";
function safeMessage(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    try {
      const url = new URL(value);
      return `${url.origin}${url.pathname}`;
    } catch {
      return "[redacted URL]";
    }
  });
}
const metadata = await fetch(
  `${base}/.well-known/oauth-authorization-server/api/oauth`,
).then((r) => r.json());
const redirect = `${base}/oauth-test-callback`;
const registered = await fetch(metadata.registration_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: clientName,
    redirect_uris: [redirect],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
});
const registration = await registered.json();
if (!registered.ok) throw new Error(JSON.stringify(registration));
console.log("OAuth dynamic client registration: passed");
const verifier = randomBytes(32).toString("base64url"),
  state = randomBytes(24).toString("base64url");
const params = new URLSearchParams({
  client_id: registration.client_id,
  redirect_uri: redirect,
  response_type: "code",
  scope:
    "document:read document:edit document:write document:create offline_access",
  state,
  resource: `${base}/mcp`,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
});
const credentials = JSON.parse(await readFile(".cache/test-user.json", "utf8"));
const document = JSON.parse(
  await readFile(".cache/test-document.json", "utf8"),
);
const browser = await chromium.launch({ headless: true });
let code;
try {
  const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      ...(process.env.OAUTH_REUSE_SESSION
        ? { storageState: ".cache/oauth-browser-state.json" }
        : {}),
    }),
    page = await context.newPage();
  page.on("pageerror", (e) =>
    console.log("Browser error:", safeMessage(e.message)),
  );
  page.on("response", (r) => {
    if (r.status() >= 400)
      console.log("HTTP", r.status(), new URL(r.url()).pathname);
  });
  await context.route(
    (url) =>
      url.origin === new URL(redirect).origin &&
      url.pathname === "/oauth-test-callback",
    async (route) => {
      const query = new URL(route.request().url()).searchParams;
      if (query.get("error"))
        console.log(
          "OAuth callback error:",
          query.get("error"),
          query.get("error_description"),
        );
      if (query.get("state") !== state) throw new Error("OAuth state mismatch");
      code = query.get("code");
      await route.fulfill({ body: "OAuth callback complete." });
    },
  );
  await page.goto(`${metadata.authorization_endpoint}?${params}`);
  await page
    .getByLabel("Email address")
    .or(page.getByRole("heading", { name: "Connect your account" }))
    .waitFor({ timeout: 30_000 });
  if (await page.getByLabel("Email address").count()) {
    await page.getByLabel("Email address").fill(credentials.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(credentials.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page
    .getByRole("heading", { name: "Connect your account" })
    .waitFor({ timeout: 30_000 });
  const id = document.id ?? new URL(document.url).searchParams.get("doc");
  document.id = id;
  await page.getByRole("button", { name: "Continue to approval" }).click();
  await page
    .getByRole("button", { name: "Allow connection" })
    .waitFor({ timeout: 30_000 });
  await page.getByText(clientName, { exact: true }).waitFor();
  await page.screenshot({ path: ".cache/oauth-consent.png", fullPage: true });
  await page.getByRole("button", { name: "Allow connection" }).click();
  await page.waitForURL(`${redirect}*`, { timeout: 30_000 });
  if (!code) throw new Error("Missing OAuth code");
  await context.storageState({ path: ".cache/oauth-browser-state.json" });
  await writeFile(
    ".cache/oauth-test-connection.json",
    JSON.stringify({ clientId: registration.client_id }),
    { mode: 0o600 },
  );
  console.log(
    "Neon Auth login, account approval, consent and callback: passed",
  );
} catch (error) {
  const pages = browser.contexts()[0]?.pages();
  if (pages?.[0]) {
    const u = new URL(pages[0].url());
    console.log(
      "Final path:",
      u.pathname,
      "OAuth error:",
      u.searchParams.get("error"),
      u.searchParams.get("error_description"),
    );
    console.log(
      "Visible errors:",
      await pages[0].locator("[role=alert],#error").allTextContents(),
    );
    await pages[0].screenshot({
      path: ".cache/oauth-failure.png",
      fullPage: true,
    });
  }
  throw new Error(safeMessage(error.message));
} finally {
  await browser.close();
}
async function exchange(body) {
  const r = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = await r.json();
  if (!r.ok)
    throw new Error(
      `Token exchange ${r.status}: ${data.error_description ?? data.error}`,
    );
  return data;
}
const token = await exchange({
  grant_type: "authorization_code",
  code,
  redirect_uri: redirect,
  client_id: registration.client_id,
  code_verifier: verifier,
  resource: `${base}/mcp`,
});
console.log("OAuth code + PKCE exchange: passed");
if (!token.refresh_token) throw new Error("Missing refresh token");
const refreshed = await exchange({
  grant_type: "refresh_token",
  refresh_token: token.refresh_token,
  client_id: registration.client_id,
  resource: `${base}/mcp`,
});
console.log("OAuth refresh: passed");
const client = new Client({ name: "oauth-smoke", version: "1.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${refreshed.access_token}` },
      },
    }),
  );
  const result = await client.callTool({
    name: "read_document",
    arguments: {
      document_id: document.id ?? new URL(document.url).searchParams.get("doc"),
    },
  });
  if (result.isError)
    throw new Error(
      "OAuth document read failed: " + JSON.stringify(result.content),
    );
  console.log("OAuth-authenticated MCP read: passed");
  const listing = await client.callTool({
    name: "list_documents",
    arguments: {},
  });
  if (
    listing.isError ||
    !JSON.parse(listing.content[0].text).documents.some(
      (d) => d.id === document.id,
    )
  )
    throw new Error("OAuth account discovery failed");
  const created = await client.callTool({
    name: "create_document",
    arguments: {
      request_id: crypto.randomUUID(),
      title: "OAuth account create smoke",
      markdown: "Created through OAuth.",
    },
  });
  if (created.isError) throw new Error("OAuth document creation failed");
  const createdId = JSON.parse(created.content[0].text).document_id;
  try {
    const readNew = await client.callTool({
      name: "read_document",
      arguments: { document_id: createdId },
    });
    if (
      readNew.isError ||
      !JSON.parse(readNew.content[0].text).markdown.includes(
        "Created through OAuth",
      )
    )
      throw new Error("OAuth read of newly created document failed");
    console.log(
      "OAuth account discovery, creation and second-document read: passed",
    );
  } finally {
    const { Pool } = await import("pg");
    const cleanup = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await cleanup.query("DELETE FROM documents WHERE id=$1", [createdId]);
    } finally {
      await cleanup.end();
    }
  }
} finally {
  await client.close();
}
const { token: human } = await testIdentity(base),
  headers = { Authorization: `Bearer ${human}` };
const grants = await fetch(`${base}/api/grants`, {
  headers,
}).then((r) => r.json());
const grant = grants.find((g) => g.oauth_client_id === registration.client_id);
if (!grant) throw new Error("Missing OAuth grant");
await fetch(`${base}/api/grants/${grant.id}`, { method: "DELETE", headers });
const revoked = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${refreshed.access_token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
if (revoked.status !== 401)
  throw new Error("Revoked OAuth access token accepted");
try {
  await exchange({
    grant_type: "refresh_token",
    refresh_token: refreshed.refresh_token,
    client_id: registration.client_id,
    resource: `${base}/mcp`,
  });
  throw new Error("Revoked OAuth grant refreshed");
} catch (error) {
  if (error.message === "Revoked OAuth grant refreshed") throw error;
  console.log("Account grant revokes OAuth access and refresh: passed");
}
try {
  await exchange({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: registration.client_id,
    code_verifier: verifier,
    resource: `${base}/mcp`,
  });
  throw new Error("Authorization code replay accepted");
} catch (error) {
  if (error.message === "Authorization code replay accepted") throw error;
  console.log("Authorization code replay rejected: passed");
}
