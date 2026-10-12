import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { createDocument } from "../src/shared/codec";
import { readBlocks, prepareEdit } from "../src/server/editing";
const source =
  "# Performance sample\n\n" +
  Array.from(
    { length: 300 },
    (_, i) =>
      `Paragraph ${i}: ` + "Words for a collaborative writing demo. ".repeat(4),
  ).join("\n\n");
const doc = createDocument(source),
  id = "00000000-0000-0000-0000-000000000001";
const reads: number[] = [],
  edits: number[] = [];
let delta = 0;
for (let i = 0; i < 10; i++) {
  let start = performance.now();
  const blocks = readBlocks(doc, id);
  reads.push(performance.now() - start);
  const target = blocks[151];
  start = performance.now();
  const result = prepareEdit(doc, id, [
    {
      type: "replace_text",
      ref: target.ref,
      expected_hash: target.hash,
      expected_text: "Words",
      replacement: "Ideas",
      occurrence: 0,
    },
  ]);
  edits.push(performance.now() - start);
  delta = result.update!.length;
  result.draft.destroy();
}
const median = (values: number[]) =>
  Math.round(values.sort((a, b) => a - b)[Math.floor(values.length / 2)]);
console.log(
  JSON.stringify({
    paragraphs: 300,
    markdown_bytes: Buffer.byteLength(source),
    encoded_bytes: Y.encodeStateAsUpdate(doc).length,
    median_read_ms: median(reads),
    median_edit_ms: median(edits),
    delta_bytes: delta,
    samples: 10,
    scope: "local headless codec; excludes network and database",
  }),
);
doc.destroy();
