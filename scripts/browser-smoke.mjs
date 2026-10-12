import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
const appUrl = process.env.SMOKE_APP_URL ?? "http://localhost:5180";
await mkdir(".cache", { recursive: true });
let credentials;
try {
  credentials = JSON.parse(await readFile(".cache/test-user.json", "utf8"));
} catch {
  credentials = {
    email: `margin-demo-${Date.now()}@example.com`,
    password: randomBytes(24).toString("base64url"),
    name: "Demo Writer",
  };
  await writeFile(".cache/test-user.json", JSON.stringify(credentials), {
    mode: 0o600,
  });
}
const browser = await chromium.launch({ headless: true });
let activePage;
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  activePage = page;
  page.on("console", (msg) => {
    if (["warning", "error"].includes(msg.type()))
      console.log("Console:", msg.text().slice(0, 1200));
  });
  page.on("pageerror", (error) => console.log("Browser error:", error.message));
  page.on("response", (r) => {
    if (r.status() >= 400)
      console.log("HTTP error:", r.status(), new URL(r.url()).pathname);
  });
  await page.goto(appUrl);
  await page
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await page.getByLabel("Your name").fill(credentials.name);
  await page.getByLabel("Email address").fill(credentials.email);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page
    .getByRole("button", { name: "Create your account", exact: true })
    .click();
  await page.waitForTimeout(2500);
  if (
    await page.getByRole("button", { name: "Sign in", exact: true }).count()
  ) {
    console.log(
      "Signup response:",
      await page.getByRole("alert").allTextContents(),
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
  }
  await page
    .getByRole("button", { name: "New document" })
    .waitFor({ timeout: 30_000 });
  console.log("Neon Auth browser login: passed");
  if (!process.env.SMOKE_APP_URL) {
    const tokenCheck = await page.evaluate(async () => {
      const { auth } = await import("/src/client/auth.ts");
      const r = await auth.token();
      return {
        keys: Object.keys(r),
        dataKeys: r.data ? Object.keys(r.data) : [],
        error: r.error,
      };
    });
    console.log("Token response shape:", tokenCheck);
  }
  await page.getByRole("button", { name: "New document" }).click();
  await page.getByLabel("Document title").fill("A launch worth writing about");
  await page
    .getByRole("button", { name: "Create document", exact: true })
    .click();
  await page.getByTestId("document-editor").waitFor({ timeout: 40_000 });
  console.log("Live document hydration: passed");
  await page.screenshot({ path: ".cache/editor-desktop.png", fullPage: true });
  await context.storageState({ path: ".cache/browser-session.json" });
  await writeFile(
    ".cache/test-document.json",
    JSON.stringify({ url: page.url() }),
  );
  const other = await context.newPage();
  await other.goto(page.url());
  await other.getByTestId("document-editor").waitFor({ timeout: 40_000 });
  const editor = page.getByTestId("document-editor");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("A real-time sentence from the first window.");
  await other
    .getByTestId("document-editor")
    .getByText("A real-time sentence from the first window.")
    .waitFor({ timeout: 30_000 });
  console.log("Two-window Realtime editing: passed");
  await page.getByLabel("Document actions").click();
  await page.getByRole("button", { name: "Show live sync details" }).click();
  await page.screenshot({
    path: ".cache/editor-inspector.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel("Document actions").click();
  await page.getByRole("button", { name: "Hide sync details" }).click();
  await page.screenshot({
    path: ".cache/editor-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
} catch (error) {
  console.error(error.message);
  if (activePage) {
    console.log(
      "Visible status:",
      await activePage
        .locator(".sync-notice,.save-state,.app-error")
        .allTextContents(),
    );
    await activePage.screenshot({
      path: ".cache/browser-failure.png",
      fullPage: true,
    });
  }
  throw error;
} finally {
  await browser.close();
}
