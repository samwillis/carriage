import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import * as Y from "yjs";
import { decodeBase64, encodeBase64 } from "../src/shared/codec.ts";
import { testIdentity } from "./test-auth.mjs";
const base = process.env.SMOKE_APP_URL ?? "https://carriage-neon.vercel.app";
const apiBase =
  process.env.SMOKE_API_URL ??
  "https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build";
const { token } = await testIdentity(apiBase);
async function api(path, body) {
  const r = await fetch(apiBase + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  if (!r.ok)
    throw new Error(
      `Test API ${r.status}: ${new URL(apiBase + path).pathname}`,
    );
  return r.json();
}
const storageState = JSON.parse(
  await readFile(".cache/browser-session.json", "utf8"),
);
const browser = await chromium.launch({ headless: true });
const database = new Pool({ connectionString: process.env.DATABASE_URL });
let doc;
let pages = [];
async function select(page, from, to) {
  await page.bringToFront();
  await page.getByTestId("document-editor").focus();
  await page.evaluate(
    ({ from, to }) => {
      const paragraph = document.querySelector(
        '[data-testid="document-editor"] p',
      );
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode()))
        if (!node.parentElement.closest(".ProseMirror-yjs-cursor"))
          nodes.push(node);
      const point = (offset) => {
        for (const node of nodes) {
          if (offset <= node.textContent.length) return [node, offset];
          offset -= node.textContent.length;
        }
        throw new Error("Selection offset exceeds paragraph");
      };
      const range = document.createRange();
      range.setStart(...point(from));
      range.setEnd(...point(to));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    },
    { from, to },
  );
}
async function selectionSeen(page, text) {
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll(".ProseMirror-yjs-selection")]
        .map((node) => node.textContent)
        .join("") === text,
    text,
    { timeout: 20000 },
  );
}
try {
  doc = await api("/api/documents", {
    title: "Live cursor regression",
    markdown: "Alpha bravo charlie.\n\nDelta echo foxtrot.",
  });
  const first = await browser.newContext({
      storageState,
      viewport: { width: 1400, height: 900 },
    }),
    second = await browser.newContext({
      storageState,
      viewport: { width: 1400, height: 900 },
    });
  const page = await first.newPage(),
    other = await second.newPage();
  pages = [page, other];
  const errors = [];
  for (const tab of [page, other]) {
    tab.on("response", (response) => {
      if (
        response.status() >= 400 &&
        new URL(response.url()).pathname.endsWith("/presence")
      )
        console.log("Presence request failed:", response.status());
    });
    tab.on("pageerror", (error) => errors.push(error.message));
    await tab.goto(`${base}/?doc=${doc.id}`);
    await tab.getByTestId("document-editor").waitFor({ timeout: 30000 });
  }
  await select(page, 6, 11);
  await selectionSeen(other, "bravo");
  await other.locator(".ProseMirror-yjs-cursor").waitFor();
  const firstColor = await other
    .locator(".ProseMirror-yjs-cursor")
    .evaluate((node) => node.style.borderColor);
  if (
    !(await other.locator(".ProseMirror-yjs-cursor").textContent()).includes(
      "another tab",
    )
  )
    throw new Error("Same-account cursor label missing");
  const initial = await api(`/api/documents/${doc.id}/bootstrap`);
  if (initial.document.head !== 0 || initial.tail.length)
    throw new Error("Cursor movement changed document history");
  console.log(
    "Same-account cursor, selection, and no document-history writes: passed.",
  );
  const replica = new Y.Doc();
  Y.applyUpdate(replica, decodeBase64(initial.snapshot));
  let delta;
  replica.on("update", (update) => {
    delta = update;
  });
  replica.getXmlFragment("prosemirror").get(0).get(0).insert(0, "Hey, ");
  await api(`/api/documents/${doc.id}/updates`, {
    request_id: randomUUID(),
    update: encodeBase64(delta),
  });
  await other
    .getByTestId("document-editor")
    .getByText("Hey, Alpha", { exact: false })
    .waitFor({ timeout: 20000 });
  await selectionSeen(other, "bravo");
  console.log(
    "Concurrent insertion preserves selection on the original characters: passed.",
  );
  await other.reload();
  await other.getByTestId("document-editor").waitFor({ timeout: 30000 });
  await selectionSeen(other, "bravo");
  console.log("Reconnect restores active selection: passed.");
  await page.getByRole("button", { name: "Share", exact: true }).focus();
  await other
    .locator(".ProseMirror-yjs-cursor")
    .waitFor({ state: "detached", timeout: 20000 });
  console.log("Blur clears the remote cursor: passed.");
  await select(other, 11, 16);
  await selectionSeen(page, "bravo");
  const secondColor = await page
    .locator(".ProseMirror-yjs-cursor")
    .evaluate((node) => node.style.borderColor);
  if (firstColor === secondColor)
    throw new Error("Browser sessions have indistinguishable colors");
  await page.screenshot({
    path: ".cache/live-cursors.png",
    animations: "disabled",
  });
  const synthetic = randomUUID(),
    cursor = {
      anchor: { tname: "prosemirror", assoc: 0 },
      head: { tname: "prosemirror", assoc: 0 },
    };
  await api(`/api/documents/${doc.id}/presence`, {
    session_id: synthetic,
    activity: "Viewing",
    sequence: 2,
    cursor: null,
  });
  await api(`/api/documents/${doc.id}/presence`, {
    session_id: synthetic,
    activity: "Viewing",
    sequence: 1,
    cursor,
  });
  const {
    rows: [presence],
  } = await database.query(
    "SELECT cursor,cursor_version FROM document_presence WHERE document_id=$1 AND session_id=$2",
    [doc.id, synthetic],
  );
  if (presence.cursor !== null || Number(presence.cursor_version) !== 2)
    throw new Error("Older request replaced newer presence");
  if (errors.length) throw new Error("Browser errors: " + errors.join("; "));
  console.log(
    "Reverse-direction selection and out-of-order presence protection: passed.",
  );
  replica.destroy();
} catch (error) {
  for (const [index, page] of pages.entries())
    console.log(
      "Cursor debug",
      index,
      await page.evaluate(() => ({
        focus: document.hasFocus(),
        selection: window.getSelection()?.toString(),
        cursors: [...document.querySelectorAll(".ProseMirror-yjs-cursor")].map(
          (node) => node.textContent,
        ),
        selections: [
          ...document.querySelectorAll(".ProseMirror-yjs-selection"),
        ].map((node) => node.textContent),
      })),
    );
  if (doc)
    console.log(
      "Stored cursors:",
      (
        await database.query(
          "SELECT cursor,cursor_version FROM document_presence WHERE document_id=$1",
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
  if (doc) await database.query("DELETE FROM documents WHERE id=$1", [doc.id]);
  await database.end();
}
