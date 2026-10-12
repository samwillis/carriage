import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { testIdentity } from "./test-auth.mjs";
const base = process.env.SMOKE_API_URL ?? "http://localhost:3080";
const identity = await testIdentity(base);
const humanHeaders = {
  Authorization: `Bearer ${identity.token}`,
  "Content-Type": "application/json",
};
const doc = await fetch(`${base}/api/documents`, {
  method: "POST",
  headers: humanHeaders,
  body: JSON.stringify({
    title: "MCP integration test",
    markdown: "# Agent test\n\nOne paragraph.\n\nAnother paragraph.",
  }),
}).then((r) => r.json());
if (!doc.id) throw new Error("Could not create test document.");
for (const method of ["GET", "POST"]) {
  const removed = await fetch(`${base}/api/documents/${doc.id}/grants`, {
    method,
    headers: humanHeaders,
  });
  if (removed.status !== 404)
    throw new Error(`Document connection route still exists (${method}).`);
}
console.log("Document-specific connection routes removed: passed");
const grant = await fetch(`${base}/api/grants`, {
  method: "POST",
  headers: humanHeaders,
  body: JSON.stringify({
    label: "Smoke test agent",
    scopes: ["read", "edit", "write", "create"],
    days: 1,
  }),
}).then((r) => r.json());
if (!grant.token) throw new Error("Could not create test grant.");
let createdId: string | undefined;
const client = new Client({ name: "margin-smoke", version: "1.0.0" });
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${grant.token}` } },
    }),
  );
  const tools = await client.listTools();
  if (tools.tools.length !== 5) throw new Error("Expected five tools.");
  console.log("MCP initialize and discovery: passed");
  const listing = await client.callTool({
    name: "list_documents",
    arguments: { query: "MCP integration" },
  });
  if (
    listing.isError ||
    !JSON.parse((listing.content as any)[0].text).documents.some(
      (d: any) => d.id === doc.id,
    )
  )
    throw new Error("Account document discovery failed");
  const createArgs = {
    request_id: randomUUID(),
    title: "MCP created document",
    markdown: "Created by agent.",
  };
  const created = await client.callTool({
    name: "create_document",
    arguments: createArgs,
  });
  const replay = await client.callTool({
    name: "create_document",
    arguments: createArgs,
  });
  if (
    created.isError ||
    replay.isError ||
    JSON.stringify(created.content) !== JSON.stringify(replay.content)
  )
    throw new Error("MCP create retry failed");
  createdId = JSON.parse((created.content as any)[0].text).document_id;
  const newRead = await client.callTool({
    name: "read_document",
    arguments: { document_id: createdId },
  });
  if (newRead.isError)
    throw new Error("Account connection could not read second document");
  console.log(
    "MCP account discovery, creation, retry and second document read: passed",
  );
  const result = await client.callTool({
    name: "read_document",
    arguments: { document_id: doc.id },
  });
  const read = JSON.parse((result.content as any)[0].text);
  const block = read.blocks.find((b: any) => b.text === "One paragraph.");
  const request_id = randomUUID(),
    args = {
      document_id: doc.id,
      request_id,
      operations: [
        {
          type: "replace_text",
          ref: block.ref,
          expected_hash: block.hash,
          expected_text: "One",
          replacement: "An edited",
          occurrence: 0,
        },
      ],
    };
  const edit = await client.callTool({
    name: "edit_document",
    arguments: args,
  });
  const retried = await client.callTool({
    name: "edit_document",
    arguments: args,
  });
  if (
    edit.isError ||
    JSON.stringify(edit.content) !== JSON.stringify(retried.content)
  )
    throw new Error("Edit retry failed.");
  console.log("MCP targeted edit and durable retry: passed");
  const before = await client.callTool({
    name: "read_document",
    arguments: { document_id: doc.id },
  });
  const current = JSON.parse((before.content as any)[0].text);
  const written = await client.callTool({
    name: "write_document",
    arguments: {
      document_id: doc.id,
      request_id: randomUUID(),
      expected_revision: current.revision,
      markdown: current.markdown + "\nA full write.\n",
    },
  });
  if (written.isError) throw new Error("Full write failed.");
  console.log("MCP full write: passed");
  await fetch(`${base}/api/grants/${grant.id}`, {
    method: "DELETE",
    headers: humanHeaders,
  });
  try {
    await client.callTool({
      name: "read_document",
      arguments: { document_id: doc.id },
    });
    throw new Error("Revoked grant accepted");
  } catch (error) {
    if ((error as Error).message === "Revoked grant accepted") throw error;
    console.log("MCP token revocation: passed");
  }
} finally {
  await client.close();
  const { pool } = await import("../src/server/db");
  await pool.query("DELETE FROM documents WHERE id=ANY($1::uuid[])", [
    [doc.id, ...(createdId ? [createdId] : [])],
  ]);
  await pool.query("DELETE FROM agent_grants WHERE id=$1", [grant.id]);
  await pool.end();
}
