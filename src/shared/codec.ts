import * as commonmark from "@milkdown/kit/preset/commonmark";
import * as gfm from "@milkdown/kit/preset/gfm";
import { Container, Clock, Ctx } from "@milkdown/ctx";
import {
  nodesCtx,
  marksCtx,
  remarkStringifyOptionsCtx,
} from "@milkdown/kit/core";
import { Schema, type Node as ProseNode } from "@milkdown/kit/prose/model";
import { ParserState, SerializerState } from "@milkdown/transformer";
import { remark } from "remark";
import remarkGfm from "remark-gfm";
import remarkInlineLinks from "remark-inline-links";
import { visit } from "unist-util-visit";
import * as Y from "yjs";
import { initProseMirrorDoc, updateYFragment } from "y-prosemirror";
import { LIMITS } from "./contracts";

// Use the pinned preset's actual factories. No second hand-maintained schema.
const ctx = new Ctx(new Container(), new Clock());
ctx.inject(nodesCtx).inject(marksCtx).inject(remarkStringifyOptionsCtx);
for (const plugin of [...commonmark.schema, ...gfm.schema]) {
  await plugin(ctx)();
}
export const schema = new Schema({
  nodes: Object.fromEntries(ctx.get(nodesCtx)),
  marks: Object.fromEntries(ctx.get(marksCtx)),
});
const markdown = remark()
  .use(remarkGfm)
  .use(remarkInlineLinks)
  .use(() => (tree: any, file: any) => {
    visit(tree, "list", (node: any) => {
      if (node.ordered)
        node.children.forEach((item: any, i: number) => {
          item.label = (node.start ?? 1) + i;
        });
    });
    visit(tree, (node: any) => {
      if (["strong", "emphasis"].includes(node.type))
        node.marker = String(file.value).charAt(
          node.position?.start.offset ?? 0,
        );
      if (
        node.children?.length === 1 &&
        node.children[0].type === "html" &&
        /^<br\s*\/?\s*>$/i.test(node.children[0].value)
      )
        node.children = [];
    });
  });
const parser = ParserState.create(schema, markdown as any);
const serializer = SerializerState.create(schema, markdown as any);
const supported = new Set([
  "root",
  "paragraph",
  "heading",
  "blockquote",
  "list",
  "listItem",
  "code",
  "thematicBreak",
  "image",
  "link",
  "text",
  "strong",
  "emphasis",
  "inlineCode",
  "break",
  "delete",
  "table",
  "tableRow",
  "tableCell",
  "footnoteDefinition",
  "footnoteReference",
]);
export function parseMarkdown(source: string): ProseNode {
  if (new TextEncoder().encode(source).length > LIMITS.markdownBytes)
    throw new Error("Markdown exceeds the document limit.");
  const tree = markdown.runSync(markdown.parse(source));
  visit(tree, (node: any) => {
    if (!supported.has(node.type))
      throw new Error(`Unsupported Markdown structure: ${node.type}`);
  });
  const result = parser(source);
  result.check();
  if (!source.trim())
    return schema.node("doc", null, [schema.node("paragraph")]);
  return result;
}
export function toMarkdown(node: ProseNode): string {
  return serializer(node);
}
export function cloneDoc(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}
export function createDocument(source: string): Y.Doc {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("prosemirror");
  updateYFragment(doc, fragment, parseMarkdown(source), {
    mapping: new Map(),
    isOMark: new Map(),
  });
  return doc;
}
export function project(doc: Y.Doc) {
  for (const root of doc.share.keys())
    if (root !== "prosemirror") throw new Error("Unexpected Yjs shared root.");
  if (doc.store.pendingStructs || doc.store.pendingDs)
    throw new Error("missing_dependency");
  let repaired = false;
  const listener = () => {
    repaired = true;
  };
  doc.on("update", listener);
  let result: ReturnType<typeof initProseMirrorDoc>;
  try {
    result = initProseMirrorDoc(doc.getXmlFragment("prosemirror"), schema);
  } finally {
    doc.off("update", listener);
  }
  if (repaired)
    throw new Error(
      "Editor conversion attempted to repair unsupported content.",
    );
  result.doc.check();
  result.doc.descendants((node) => {
    if (node.type.name === "html")
      throw new Error("HTML is outside the supported Markdown schema.");
    if (
      node.type.name === "heading" &&
      (node.attrs.level < 1 || node.attrs.level > 6)
    )
      throw new Error("Invalid heading level.");
    if (node.type.name === "image" && !safeUrl(node.attrs.src, true))
      throw new Error("Unsupported image URL.");
    for (const mark of node.marks)
      if (mark.type.name === "link" && !safeUrl(mark.attrs.href))
        throw new Error("Unsupported link URL.");
  });
  if (Y.encodeStateAsUpdate(doc).byteLength > LIMITS.documentBytes)
    throw new Error("Encoded document exceeds the limit.");
  return result;
}
function safeUrl(value: unknown, image = false) {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value, "https://relative.invalid");
    return ["https:", "http:", ...(image ? [] : ["mailto:"])].includes(
      u.protocol,
    );
  } catch {
    return false;
  }
}
export function renderDocument(doc: Y.Doc): string {
  const copy = cloneDoc(doc);
  try {
    return toMarkdown(project(copy).doc);
  } finally {
    copy.destroy();
  }
}
export function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined")
    return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
export function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined")
    return new Uint8Array(Buffer.from(value, "base64"));
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
