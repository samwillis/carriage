import { z } from "zod";
export const SCHEMA_VERSION = 1;
export const LIMITS = {
  updateBytes: 256 * 1024,
  documentBytes: 1024 * 1024,
  markdownBytes: 128 * 1024,
  operations: 32,
  attempts: 6,
};
export const requestId = z.string().uuid();
export const documentId = z.string().uuid();
const positionId = z.object({
  client: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  clock: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const relativePosition = z
  .object({
    type: positionId.nullable().optional(),
    tname: z.literal("prosemirror").nullable().optional(),
    item: positionId.nullable().optional(),
    assoc: z.number().int().min(-1).max(1).optional(),
  })
  .refine(
    (position) => Boolean(position.type || position.tname),
    "Position needs a shared type.",
  );
export const cursorSelection = z.object({
  anchor: relativePosition,
  head: relativePosition,
});
export const presenceInput = z.object({
  session_id: z.string().uuid(),
  activity: z.enum(["Viewing", "Editing", "Idle"]),
  cursor: cursorSelection.nullable().default(null),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  leaving: z.boolean().default(false),
});
export type CursorSelection = z.infer<typeof cursorSelection>;
export const editOperation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace_text"),
    ref: z.string(),
    expected_hash: z.string(),
    expected_text: z.string().min(1),
    replacement: z.string(),
    occurrence: z.number().int().nonnegative().default(0),
  }),
  z.object({
    type: z.literal("replace_block"),
    ref: z.string(),
    expected_hash: z.string(),
    markdown: z.string(),
  }),
  z.object({
    type: z.literal("delete_block"),
    ref: z.string(),
    expected_hash: z.string(),
  }),
  z.object({
    type: z.literal("insert_before"),
    ref: z.string(),
    expected_hash: z.string(),
    markdown: z.string(),
  }),
  z.object({
    type: z.literal("insert_after"),
    ref: z.string(),
    expected_hash: z.string(),
    markdown: z.string(),
  }),
]);
export type EditOperation = z.infer<typeof editOperation>;
export const editInput = z.object({
  document_id: documentId,
  request_id: requestId,
  operations: z.array(editOperation).min(1).max(LIMITS.operations),
});
export const writeInput = z.object({
  document_id: documentId,
  request_id: requestId,
  expected_revision: z.number().int().nonnegative(),
  markdown: z.string().max(LIMITS.markdownBytes),
});
export const readInput = z.object({
  document_id: documentId,
  mode: z.enum(["full", "outline", "blocks"]).default("full"),
  refs: z.array(z.string()).max(100).optional(),
  if_revision: z.number().int().optional(),
});
export const listInput = z.object({
  query: z.string().trim().max(200).default(""),
  limit: z.number().int().min(1).max(100).default(30),
  after: documentId.optional(),
});
export const createInput = z.object({
  request_id: requestId,
  title: z.string().trim().min(1).max(200),
  markdown: z.string().max(LIMITS.markdownBytes).default(""),
});
export interface DocumentInfo {
  id: string;
  title: string;
  role: "owner" | "editor" | "viewer";
  head: number;
  snapshot_revision: number;
  pending_count: number;
  pending_bytes: string;
  schema_version: number;
  compaction_until: string | null;
  updated_at: string;
}
export type DocumentSummary = Pick<
  DocumentInfo,
  "id" | "title" | "role" | "updated_at"
>;
export interface Bootstrap {
  document: DocumentInfo;
  snapshot: string;
  tail: { revision: number; update: string }[];
  markdown: string;
  server_time: number;
}
export interface Presence {
  session_id: string;
  user_id: string;
  label: string;
  kind: "person" | "agent";
  activity: string;
  expires_at: Date | string;
  cursor: CursorSelection | null;
  cursor_version: string | number;
  updated_at?: Date | string;
}
export interface Block {
  ref: string;
  hash: string;
  type: string;
  markdown: string;
  text: string;
}
export interface WriteResult {
  revision: number;
  unchanged: boolean;
  blocks?: Block[];
}
export interface ReadResult {
  document_id: string;
  title: string;
  revision: number;
  schema_version: number;
  unchanged?: boolean;
  markdown?: string;
  blocks?: Block[];
}
