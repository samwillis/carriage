import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  createDocument,
  renderDocument,
  cloneDoc,
  project,
} from "../src/shared/codec";
import { readBlocks, prepareEdit, prepareWrite } from "../src/server/editing";
const id = "00000000-0000-0000-0000-000000000001";
describe("agent editing through the Milkdown schema", () => {
  it("roundtrips GFM and preserves unrelated block identities", () => {
    const doc = createDocument(
      "# Title\n\nFirst **bold** paragraph.\n\nMiddle stays.\n\nLast paragraph.\n\n- [x] Done\n- [ ] Next\n",
    );
    const blocks = readBlocks(doc, id);
    const first = blocks.find((b) => b.text === "First bold paragraph.")!;
    const middle = blocks.find((b) => b.text === "Middle stays.")!;
    const last = blocks.find((b) => b.text === "Last paragraph.")!;
    const changed = prepareEdit(doc, id, [
      {
        type: "replace_text",
        ref: first.ref,
        expected_hash: first.hash,
        expected_text: "bold",
        replacement: "strong",
        occurrence: 0,
      },
      {
        type: "replace_text",
        ref: last.ref,
        expected_hash: last.hash,
        expected_text: "Last",
        replacement: "Final",
        occurrence: 0,
      },
    ]);
    expect(renderDocument(changed.draft)).toContain("**strong**");
    expect(readBlocks(changed.draft, id, [middle.ref])[0].hash).toBe(
      middle.hash,
    );
    expect(renderDocument(doc)).toContain("**bold**");
    changed.draft.destroy();
    doc.destroy();
  });
  it("rejects deleted targets rather than editing a neighbor", () => {
    const doc = createDocument("One.\n\nTwo.\n\nThree.");
    const two = readBlocks(doc, id)[1];
    const deleted = prepareEdit(doc, id, [
      { type: "delete_block", ref: two.ref, expected_hash: two.hash },
    ]);
    expect(() =>
      prepareEdit(deleted.draft, id, [
        {
          type: "replace_text",
          ref: two.ref,
          expected_hash: two.hash,
          expected_text: "Two",
          replacement: "Oops",
          occurrence: 0,
        },
      ]),
    ).toThrow();
    deleted.draft.destroy();
    doc.destroy();
  });
  it("preflights the whole batch and detects overlaps", () => {
    const doc = createDocument("Hello world.");
    const block = readBlocks(doc, id)[0];
    expect(() =>
      prepareEdit(doc, id, [
        { type: "delete_block", ref: block.ref, expected_hash: block.hash },
        {
          type: "replace_text",
          ref: block.ref,
          expected_hash: block.hash,
          expected_text: "Hello",
          replacement: "Hi",
          occurrence: 0,
        },
      ]),
    ).toThrow();
    expect(renderDocument(doc)).toContain("Hello world.");
    doc.destroy();
  });
  it("rejects inserting beside a target removed by the same batch", () => {
    const doc = createDocument("Anchor.\n\nKeep.");
    const block = readBlocks(doc, id)[0];
    expect(() =>
      prepareEdit(doc, id, [
        { type: "delete_block", ref: block.ref, expected_hash: block.hash },
        {
          type: "insert_after",
          ref: block.ref,
          expected_hash: block.hash,
          markdown: "New.",
        },
      ]),
    ).toThrow();
    doc.destroy();
  });
  it("orders multiple insertions and records no-op edits", () => {
    const doc = createDocument("Anchor.");
    const block = readBlocks(doc, id)[0];
    const next = prepareEdit(doc, id, [
      {
        type: "insert_after",
        ref: block.ref,
        expected_hash: block.hash,
        markdown: "First.",
      },
      {
        type: "insert_after",
        ref: block.ref,
        expected_hash: block.hash,
        markdown: "Second.",
      },
    ]);
    expect(renderDocument(next.draft)).toBe("Anchor.\n\nFirst.\n\nSecond.\n");
    const noop = prepareWrite(doc, "Anchor.");
    expect(noop.update).toBeNull();
    noop.draft.destroy();
    next.draft.destroy();
    doc.destroy();
  });
  it("rejects unsupported roots, HTML, and dangerous link URLs", () => {
    expect(() => createDocument("<script>alert(1)</script>")).toThrow();
    const doc = createDocument("Safe");
    const invalid = cloneDoc(doc);
    invalid.getMap("extra").set("x", 1);
    expect(() => project(invalid)).toThrow();
    const link = createDocument("[link](javascript:alert)");
    expect(() => project(link)).toThrow();
    doc.destroy();
    invalid.destroy();
    link.destroy();
  });
  it("accepts independent concurrent updates in either order", () => {
    const doc = createDocument("One.\n\nTwo.");
    const blocks = readBlocks(doc, id);
    const a = prepareEdit(doc, id, [
      {
        type: "replace_text",
        ref: blocks[0].ref,
        expected_hash: blocks[0].hash,
        expected_text: "One",
        replacement: "First",
        occurrence: 0,
      },
    ]);
    const b = prepareEdit(doc, id, [
      {
        type: "replace_text",
        ref: blocks[1].ref,
        expected_hash: blocks[1].hash,
        expected_text: "Two",
        replacement: "Second",
        occurrence: 0,
      },
    ]);
    Y.applyUpdate(a.draft, b.update!);
    Y.applyUpdate(b.draft, a.update!);
    expect(renderDocument(a.draft)).toBe(renderDocument(b.draft));
    expect(renderDocument(a.draft)).toContain("First.\n\nSecond.");
    a.draft.destroy();
    b.draft.destroy();
    doc.destroy();
  });
});
