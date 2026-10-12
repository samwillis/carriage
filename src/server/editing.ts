import * as Y from "yjs";
import { Transform } from "@milkdown/kit/prose/transform";
import { Fragment, type Node as ProseNode } from "@milkdown/kit/prose/model";
import {
  updateYFragment,
  absolutePositionToRelativePosition,
} from "y-prosemirror";
import {
  cloneDoc,
  parseMarkdown,
  project,
  toMarkdown,
  encodeBase64,
  decodeBase64,
  schema,
} from "../shared/codec";
import {
  SCHEMA_VERSION,
  type Block,
  type EditOperation,
  type CursorSelection,
} from "../shared/contracts";
import { hash } from "./identity";
import { fail, AppError } from "./errors";

interface Target {
  node: ProseNode;
  pos: number;
  type: Y.XmlElement;
  ref: string;
}
interface PreparedEdit {
  draft: Y.Doc;
  update: Uint8Array | null;
  unchanged: boolean;
  cursor?: CursorSelection | null;
}
function selection(
  projection: ReturnType<typeof project>,
  doc: Y.Doc,
  from: number,
  to: number,
): CursorSelection {
  const root = doc.getXmlFragment("prosemirror");
  const max = Math.max(0, projection.doc.content.size - 1);
  return {
    anchor: Y.relativePositionToJSON(
      absolutePositionToRelativePosition(
        Math.max(0, Math.min(from, max)),
        root,
        projection.meta.mapping,
      ),
    ),
    head: Y.relativePositionToJSON(
      absolutePositionToRelativePosition(
        Math.max(0, Math.min(to, max)),
        root,
        projection.meta.mapping,
      ),
    ),
  } as CursorSelection;
}
export function blockCursor(
  doc: Y.Doc,
  id: string,
  refs?: string[],
): CursorSelection | null {
  if (!refs?.length) return null;
  const copy = cloneDoc(doc);
  try {
    const { projection, entries } = targets(copy, id);
    const target = resolve(copy, id, refs[0], entries);
    return selection(
      projection,
      copy,
      target.pos + 1,
      target.pos + target.node.nodeSize - 1,
    );
  } finally {
    copy.destroy();
  }
}
export function targets(doc: Y.Doc, documentId: string) {
  const projection = project(doc);
  const entries: Target[] = [];
  const elements = new Map<ProseNode, Y.XmlElement>();
  for (const [type, node] of projection.meta.mapping)
    if (type instanceof Y.XmlElement && !Array.isArray(node))
      elements.set(node, type);
  projection.doc.descendants((node, pos) => {
    // Structural list/table children cannot be serialized or replaced as a
    // standalone Markdown block. Their paragraphs and outer containers can.
    if (
      node.isText ||
      !node.isBlock ||
      !schema.topNodeType.validContent(Fragment.from(node))
    )
      return;
    const type = elements.get(node);
    if (type) {
      const anchor = Y.createRelativePositionFromTypeIndex(type, 0);
      const ref = encodeBase64(
        new TextEncoder().encode(
          JSON.stringify({
            d: documentId,
            v: SCHEMA_VERSION,
            a: encodeBase64(Y.encodeRelativePosition(anchor)),
          }),
        ),
      );
      entries.push({ node, pos, type, ref });
    }
  });
  return { projection, entries };
}
export function blockView(target: Target): Block {
  return {
    ref: target.ref,
    hash: hash(JSON.stringify(target.node.toJSON())),
    type: target.node.type.name,
    markdown: toMarkdown(schema.node("doc", null, [target.node])),
    text: target.node.textContent,
  };
}
export function readBlocks(doc: Y.Doc, id: string, refs?: string[]): Block[] {
  const copy = cloneDoc(doc);
  try {
    const { entries } = targets(copy, id);
    if (!refs) return entries.map(blockView);
    return refs.map((ref) => blockView(resolve(copy, id, ref, entries)));
  } finally {
    copy.destroy();
  }
}
function resolve(doc: Y.Doc, id: string, ref: string, entries: Target[]) {
  try {
    const token = JSON.parse(new TextDecoder().decode(decodeBase64(ref)));
    if (token.d !== id || token.v !== SCHEMA_VERSION)
      fail(
        409,
        "target_conflict",
        "Reference belongs to another document or schema.",
      );
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(decodeBase64(token.a)),
      doc,
      false,
    );
    const target = entries.find((entry) => entry.type === absolute?.type);
    if (!target)
      fail(
        409,
        "target_conflict",
        "The referenced block was deleted or replaced. Read it again.",
      );
    return target;
  } catch (error) {
    if (error instanceof Error && error.name === "AppError") throw error;
    fail(
      409,
      "target_conflict",
      "The referenced block is unavailable. Read it again.",
    );
  }
}
export function prepareEdit(
  committed: Y.Doc,
  id: string,
  operations: EditOperation[],
): PreparedEdit {
  const draft = cloneDoc(committed);
  try {
    const { projection, entries } = targets(draft, id);
    const changes = operations.map((operation, index) => {
      const target = resolve(draft, id, operation.ref, entries);
      if (
        hash(JSON.stringify(target.node.toJSON())) !== operation.expected_hash
      )
        fail(
          409,
          "target_conflict",
          "The target block changed. Read it again.",
        );
      let from = target.pos,
        to = target.pos + target.node.nodeSize;
      let content: Fragment;
      if (operation.type === "replace_text") {
        if (!target.node.isTextblock)
          fail(
            400,
            "invalid_edit",
            "Text replacements target a paragraph, heading, or code block.",
          );
        // Text offsets follow ProseMirror textBetween, preserving marks at the match.
        const text = target.node.textBetween(
          0,
          target.node.content.size,
          "\n",
          "\ufffc",
        );
        let at = -1,
          search = 0;
        for (let i = 0; i <= operation.occurrence; i++) {
          at = text.indexOf(operation.expected_text, search);
          if (at < 0)
            fail(
              409,
              "target_conflict",
              "Selected text changed or is no longer present.",
            );
          search = at + operation.expected_text.length;
        }
        from = target.pos + 1 + at;
        to = from + operation.expected_text.length;
        const selected = projection.doc.slice(from, to);
        const marks = selected.content.firstChild?.marks ?? [];
        selected.content.forEach((node) => {
          if (
            !node.isText ||
            !node.marks.every((mark, i) => mark.eq(marks[i])) ||
            node.marks.length !== marks.length
          )
            fail(
              400,
              "mixed_format",
              "Replace text within a single formatting run, or replace the guarded block.",
            );
        });
        content = operation.replacement
          ? Fragment.from(schema.text(operation.replacement, marks))
          : Fragment.empty;
      } else {
        content =
          operation.type === "delete_block"
            ? Fragment.empty
            : parseMarkdown(operation.markdown).content;
        if (operation.type === "insert_before") to = from;
        if (operation.type === "insert_after") from = to;
      }
      return {
        from,
        to,
        content,
        index,
        target,
        removes:
          operation.type === "replace_block" ||
          operation.type === "delete_block",
      };
    });
    for (let i = 0; i < changes.length; i++)
      for (let j = i + 1; j < changes.length; j++) {
        const a = changes[i],
          b = changes[j];
        if (
          (a.removes &&
            b.target.pos >= a.target.pos &&
            b.target.pos + b.target.node.nodeSize <=
              a.target.pos + a.target.node.nodeSize) ||
          (b.removes &&
            a.target.pos >= b.target.pos &&
            a.target.pos + a.target.node.nodeSize <=
              b.target.pos + b.target.node.nodeSize)
        )
          fail(
            400,
            "overlapping_edits",
            "Batch operations remove another operation’s target.",
          );
        if (
          Math.max(a.from, b.from) < Math.min(a.to, b.to) ||
          (a.from < a.to && b.from >= a.from && b.from < a.to) ||
          (b.from < b.to && a.from >= b.from && a.from < b.to)
        )
          fail(
            400,
            "overlapping_edits",
            "Batch operations overlap or remove another target.",
          );
      }
    // Descending original position; equal insertion anchors follow input order.
    changes.sort((a, b) => b.from - a.from || b.index - a.index);
    const transform = new Transform(projection.doc);
    const intermediates: ProseNode[] = [];
    for (const change of changes) {
      transform.replaceWith(change.from, change.to, change.content);
      transform.doc.check();
      intermediates.push(transform.doc);
    }
    if (transform.doc.eq(projection.doc))
      return { draft, update: null, unchanged: true };
    let update: Uint8Array | null = null;
    const capture = (bytes: Uint8Array) => {
      update = bytes;
    };
    draft.on("update", capture);
    try {
      draft.transact(() => {
        for (const node of intermediates)
          updateYFragment(
            draft,
            draft.getXmlFragment("prosemirror"),
            node,
            projection.meta,
          );
      }, "agent");
    } finally {
      draft.off("update", capture);
    }
    validateCopy(draft);
    const first = changes.find((change) => change.index === 0)!;
    const copy = cloneDoc(draft);
    let cursor: CursorSelection;
    try {
      cursor = selection(
        project(copy),
        copy,
        transform.mapping.map(first.from, -1),
        transform.mapping.map(first.to, 1),
      );
    } finally {
      copy.destroy();
    }
    return { draft, update, unchanged: !update, cursor };
  } catch (error) {
    draft.destroy();
    if (error instanceof AppError) throw error;
    fail(
      400,
      "invalid_edit",
      error instanceof Error ? error.message : "Unsupported edit.",
    );
  }
}
function validateCopy(doc: Y.Doc) {
  const copy = cloneDoc(doc);
  try {
    project(copy);
  } finally {
    copy.destroy();
  }
}
export function prepareWrite(committed: Y.Doc, source: string): PreparedEdit {
  const draft = cloneDoc(committed);
  try {
    const projection = project(draft);
    const next = parseMarkdown(source);
    if (projection.doc.eq(next))
      return { draft, update: null, unchanged: true };
    let update: Uint8Array | null = null;
    const capture = (bytes: Uint8Array) => {
      update = bytes;
    };
    draft.on("update", capture);
    try {
      draft.transact(
        () =>
          updateYFragment(
            draft,
            draft.getXmlFragment("prosemirror"),
            next,
            projection.meta,
          ),
        "agent",
      );
    } finally {
      draft.off("update", capture);
    }
    validateCopy(draft);
    return { draft, update, unchanged: !update };
  } catch (error) {
    draft.destroy();
    if (error instanceof AppError) throw error;
    fail(
      400,
      "invalid_markdown",
      error instanceof Error ? error.message : "Unsupported Markdown.",
    );
  }
}
