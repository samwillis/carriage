import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { testIdentity } from "./test-auth.mjs";
const base =
  process.env.SMOKE_APP_URL ??
  "https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build";
const { token } = await testIdentity(base);
const response = await fetch(`${base}/api/documents`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    title: "Presence regression check",
    markdown: "# Write together\n\nA shared page.",
  }),
});
if (!response.ok)
  throw new Error(`Create test document failed (${response.status})`);
const doc = await response.json();
const storageState = JSON.parse(
  await readFile(".cache/browser-session.json", "utf8"),
);
const browser = await chromium.launch({ headless: true });
const database = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const first = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
  });
  const second = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 },
  });
  const page = await first.newPage(),
    other = await second.newPage();
  await page.goto(`${base}/?doc=${doc.id}`);
  await page.getByTestId("document-editor").waitFor({ timeout: 30000 });
  await expect(page.locator(".presence")).toBeHidden();
  await other.goto(`${base}/?doc=${doc.id}`);
  await other.getByTestId("document-editor").waitFor({ timeout: 30000 });
  for (const tab of [page, other]) {
    await tab.getByText("2 here", { exact: true }).waitFor({ timeout: 30000 });
    await tab.locator(".presence-panel summary").click();
    await tab.getByText("Your other session", { exact: false }).waitFor();
    await tab.locator(".presence-panel summary").click();
  }
  const {
    rows: [counts],
  } = await database.query(
    "SELECT count(DISTINCT session_id)::int AS sessions,count(DISTINCT user_id)::int AS users FROM document_presence WHERE document_id=$1 AND expires_at>clock_timestamp()",
    [doc.id],
  );
  if (counts.sessions !== 2 || counts.users !== 1)
    throw new Error("Expected separate sessions for the same user");
  console.log(
    "Same-account browsers: distinct presence and explicit session labels passed.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const visible = await page.locator(".presence-count").isVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (!visible || overflow)
    throw new Error("Mobile presence visibility or page overflow failed");
  await page.screenshot({
    path: ".cache/presence-mobile.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: ".cache/presence-desktop.png",
    animations: "disabled",
  });
  console.log("Presence stays visible on mobile: passed.");
  other.on("request", (request) => {
    if (
      new URL(request.url()).pathname.endsWith("/presence") &&
      request.postDataJSON()?.leaving
    )
      console.log("Page departure keepalive: sent");
  });
  other.on("response", (response) => {
    if (
      new URL(response.url()).pathname.endsWith("/presence") &&
      response.request().postDataJSON()?.leaving
    )
      console.log("Page departure keepalive status:", response.status());
  });
  await other.goto("about:blank");
  await expect(page.locator(".presence")).toBeHidden({ timeout: 15000 });
  await second.close();
  console.log(
    "Closed browser promptly leaves presence while the remaining browser renews: passed.",
  );
} catch (error) {
  console.log(
    "Presence departure records:",
    (
      await database.query(
        "SELECT activity,cursor_version,expires_at<clock_timestamp() AS expired FROM document_presence WHERE document_id=$1",
        [doc.id],
      )
    ).rows,
  );
  throw new Error(
    String(error.message).replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
      const url = new URL(value);
      return url.origin + url.pathname;
    }),
  );
} finally {
  await browser.close();
  await database.query("DELETE FROM documents WHERE id=$1", [doc.id]);
  await database.end();
}
