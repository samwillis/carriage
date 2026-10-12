import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
const session = JSON.parse(
    await readFile(".cache/browser-session.json", "utf8"),
  ),
  doc = JSON.parse(await readFile(".cache/test-document.json", "utf8"));
const browser = await chromium.launch({ headless: true });
try {
  const writer = await browser.newContext({ storageState: session }),
    observer = await browser.newContext({ storageState: session });
  const page = await writer.newPage(),
    other = await observer.newPage();
  await page.goto(doc.url);
  await other.goto(doc.url);
  await page.getByTestId("document-editor").waitFor({ timeout: 30_000 });
  await other.getByTestId("document-editor").waitFor({ timeout: 30_000 });
  await writer.setOffline(true);
  await page.getByTestId("document-editor").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  const marker = `Offline recovery ${Date.now()}`;
  await page.keyboard.type(marker);
  await page.waitForTimeout(700);
  const persisted = await page.evaluate(async () => {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open("margin-local");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const request = open.result
          .transaction("documents")
          .objectStore("documents")
          .getAll();
        request.onsuccess = () => {
          resolve(request.result.some((r) => r.pending.length || r.inflight));
          open.result.close();
        };
        request.onerror = () => reject(request.error);
      };
    });
  });
  if (!persisted) throw new Error("Offline edits were not journaled");
  await page.close();
  await writer.setOffline(false);
  const recovered = await writer.newPage();
  await recovered.goto(doc.url);
  await recovered
    .getByTestId("document-editor")
    .getByText(marker)
    .waitFor({ timeout: 30_000 });
  await other
    .getByTestId("document-editor")
    .getByText(marker)
    .waitFor({ timeout: 30_000 });
  console.log(
    "Offline journal, closed-window recovery, and remote propagation: passed",
  );
} finally {
  await browser.close();
}
