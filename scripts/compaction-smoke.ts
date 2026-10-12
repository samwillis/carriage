import { readFile } from "node:fs/promises";
import * as Y from "yjs";
import { randomUUID } from "node:crypto";
import {
  createDocument,
  encodeBase64,
  decodeBase64,
  renderDocument,
} from "../src/shared/codec";
import { testIdentity } from "./test-auth.mjs";
import { createRealtimeClient } from "@neon/realtime/client";
const base =
  process.env.SMOKE_API_URL ??
  "https://br-frosty-poetry-w25lx1wr-margin.compute.c-1.us-east-2.aws.neon.build";
const { token } = await testIdentity(base);
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
async function request(path: string, body?: unknown) {
  const r = await fetch(base + path, {
    headers,
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${r.status}: ${data.error}`);
  return data;
}
const doc = await request("/api/documents", {
  title: "Compaction integration test",
  markdown: "Start.",
});
const local = new Y.Doc();
const initial = await request(`/api/documents/${doc.id}/bootstrap`);
Y.applyUpdate(local, decodeBase64(initial.snapshot));
const observer = new Y.Doc(),
  config = await request("/api/config"),
  sealed = await request(`/api/documents/${doc.id}/live`),
  live = createRealtimeClient({ url: config.realtimeUrl });
const snapshots = live.subscribe<any>(sealed.snapshots),
  updates = live.subscribe<any>(sealed.updates, { materialize: false });
snapshots.onChange(({ data }) => {
  for (const row of data ?? []) Y.applyUpdate(observer, row.state);
});
updates.onReset((rows) => {
  for (const row of rows) Y.applyUpdate(observer, row.row.update);
});
updates.onBatch((changes) => {
  for (const change of changes)
    if (change.type === "upsert") Y.applyUpdate(observer, change.row.update);
});
await snapshots.awaitRows((rows) => rows.length === 1, 10_000);
const text = (local.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(
  0,
) as Y.XmlText;
const started = Date.now();
try {
  for (let i = 0; i < 205; i++) {
    let bytes: Uint8Array | undefined;
    const capture = (u: Uint8Array) => {
      bytes = u;
    };
    local.on("update", capture);
    text.insert(text.length, " x");
    local.off("update", capture);
    await request(`/api/documents/${doc.id}/updates`, {
      request_id: randomUUID(),
      update: encodeBase64(bytes!),
    });
    if (i === 199)
      console.log(
        "Write-driven count threshold crossed; subsequent appends continue.",
      );
  }
  let boot = await request(`/api/documents/${doc.id}/bootstrap`);
  for (let i = 0; i < 15 && boot.document.snapshot_revision < 200; i++) {
    await new Promise((r) => setTimeout(r, 200));
    boot = await request(`/api/documents/${doc.id}/bootstrap`);
  }
  if (boot.document.head !== 205 || boot.document.snapshot_revision < 200)
    throw new Error("Compaction did not publish");
  const reconstructed = new Y.Doc();
  Y.applyUpdate(reconstructed, decodeBase64(boot.snapshot));
  for (const row of boot.tail)
    Y.applyUpdate(reconstructed, decodeBase64(row.update));
  if (renderDocument(local) !== renderDocument(reconstructed))
    throw new Error("Compaction changed the document");
  reconstructed.destroy();
  for (
    let i = 0;
    i < 30 &&
    observer.getXmlFragment("prosemirror").toString() !==
      local.getXmlFragment("prosemirror").toString();
    i++
  )
    await new Promise((r) => setTimeout(r, 100));
  if (renderDocument(observer) !== renderDocument(local))
    throw new Error("Realtime observer lost edits during compaction");
  console.log(
    JSON.stringify({
      head: boot.document.head,
      snapshot: boot.document.snapshot_revision,
      remaining_updates: boot.tail.length,
      elapsed_ms: Date.now() - started,
      verified: "write-triggered compaction and retained later edits",
    }),
  );
} finally {
  live.close();
  observer.destroy();
  local.destroy();
  const { pool } = await import("../src/server/db");
  await pool.query("DELETE FROM documents WHERE id=$1", [doc.id]);
  await pool.end();
}
