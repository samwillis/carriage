import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { testIdentity } from "./test-auth.mjs";
const doc = JSON.parse(await readFile(".cache/test-document.json", "utf8")),
  base = new URL(doc.url).origin,
  id = new URL(doc.url).searchParams.get("doc");
const { token } = await testIdentity(base),
  headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
const grant = await fetch(`${base}/api/documents/${id}/grants`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    label: "Concurrent agent test",
    scopes: ["read", "edit"],
    days: 1,
  }),
}).then((r) => r.json());
if (!grant.token) throw new Error("Missing test grant");
const browser = await chromium.launch({ headless: true }),
  client = new Client({ name: "concurrent-agent", version: "1.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
    }),
  );
  const read = await client.callTool({
      name: "read_document",
      arguments: { document_id: id },
    }),
    data = JSON.parse(read.content[0].text),
    block = data.blocks.find(
      (b) => b.type === "paragraph" && b.text.startsWith("Good writing starts"),
    );
  if (!block) throw new Error("Expected welcome paragraph");
  const context = await browser.newContext({
      storageState: JSON.parse(
        await readFile(".cache/browser-session.json", "utf8"),
      ),
    }),
    page = await context.newPage();
  await page.goto(doc.url);
  await page.getByTestId("document-editor").waitFor({ timeout: 30_000 });
  const marker = `Local undo test ${Date.now()}`;
  await page.getByTestId("document-editor").click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("Enter");
  const agentText = block.text.includes("conversation")
      ? "conversation"
      : "collaboration",
    replacement =
      agentText === "conversation" ? "collaboration" : "conversation";
  const [, result] = await Promise.all([
    page.keyboard.type(marker),
    client.callTool({
      name: "edit_document",
      arguments: {
        document_id: id,
        request_id: randomUUID(),
        operations: [
          {
            type: "replace_text",
            ref: block.ref,
            expected_hash: block.hash,
            expected_text: agentText,
            replacement,
            occurrence: 0,
          },
        ],
      },
    }),
  ]);
  if (result.isError) throw new Error("Concurrent agent edit failed");
  await page
    .getByTestId("document-editor")
    .getByText(`Good writing starts with a ${replacement}.`, { exact: false })
    .waitFor({ timeout: 30_000 });
  console.log(
    "Editor focused after remote update:",
    await page
      .getByTestId("document-editor")
      .evaluate(
        (editor) =>
          editor === document.activeElement ||
          editor.contains(document.activeElement),
      ),
  );
  await page.getByTestId("document-editor").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(500);
  const content = await page.getByTestId("document-editor").innerText();
  if (content.includes(marker))
    throw new Error("Local undo did not remove typing");
  if (!content.includes(`Good writing starts with a ${replacement}.`))
    throw new Error("Local undo removed the remote agent edit");
  console.log("Concurrent browser/agent editing and local-only undo: passed");
} finally {
  await client.close();
  await browser.close();
  await fetch(`${base}/api/grants/${grant.id}`, { method: "DELETE", headers });
}
