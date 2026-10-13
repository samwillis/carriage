import type * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import { cursorSelection, type Presence } from "../shared/contracts";

const AGENT_EDIT_HIGHLIGHT_MS = 5000;

// Remote awareness IDs live above Yjs's uint32 document client IDs. The
// authenticated session row owns this ID; callers never supply awareness IDs.
export function presenceId(sessionId: string) {
  if (/^[0-9a-f-]{36}$/i.test(sessionId))
    return Number.parseInt(
      `1${sessionId.replaceAll("-", "").slice(0, 12)}`,
      16,
    );
  let value = 2166136261;
  for (const char of sessionId)
    value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return 2 ** 32 + value;
}
export function sessionColor(sessionId: string) {
  // Distinct hues stay readable for avatars, cursor labels and selections.
  let value = 2166136261;
  for (const char of sessionId)
    value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  const hue = (value % 360) / 30,
    lightness = 0.38,
    amplitude = 0.52 * lightness;
  return `#${[0, 8, 4]
    .map((offset) => {
      const k = (offset + hue) % 12;
      return Math.round(
        255 * (lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1))),
      )
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}
export function presenceActivity(row: Presence, now = Date.now()) {
  if (row.kind === "person")
    return row.activity === "Editing" ? "Typing" : row.activity;
  const recent =
    !row.updated_at || now - new Date(row.updated_at).getTime() < 10_000;
  if (row.activity === "Reading") return recent ? "Reading" : "Read recently";
  if (row.activity === "Edited")
    return recent ? "Edited just now" : "Edited recently";
  if (row.activity === "Created")
    return recent ? "Created this document" : "Created recently";
  return row.activity;
}
export class PresenceAwareness {
  readonly awareness: Awareness;
  private highlightTimer: ReturnType<typeof setTimeout> | undefined;
  private remoteRows = new Map<string, Presence>();
  constructor(
    doc: Y.Doc,
    private sessionId: string,
    private userId: string,
    name: string,
  ) {
    this.awareness = new Awareness(doc);
    this.awareness.setLocalState({
      user: { name, color: sessionColor(sessionId) },
      cursor: null,
    });
  }
  cursor() {
    const result = cursorSelection.safeParse(
      this.awareness.getLocalState()?.cursor,
    );
    return result.success ? result.data : null;
  }
  sync(rows: Presence[], now: number) {
    clearTimeout(this.highlightTimer);
    this.highlightTimer = undefined;
    const syncedAt = Date.now();
    let nextExpiry = Infinity;
    const remote = rows
      .map((row) => {
        const previous = this.remoteRows.get(row.session_id);
        return previous &&
          Number(previous.cursor_version) > Number(row.cursor_version)
          ? previous
          : row;
      })
      .filter(
        (row) =>
          row.session_id !== this.sessionId &&
          new Date(row.expires_at).getTime() > now,
      );
    this.remoteRows = new Map(remote.map((row) => [row.session_id, row]));
    const current = new Set(remote.map((row) => presenceId(row.session_id)));
    removeAwarenessStates(
      this.awareness,
      [...this.awareness.getStates().keys()].filter(
        (id) => id !== this.awareness.clientID && !current.has(id),
      ),
      "presence",
    );
    const packet = encoding.createEncoder();
    encoding.writeVarUint(packet, remote.length);
    for (const row of remote) {
      const highlightExpiry =
        row.kind === "agent" && row.activity === "Edited" && row.updated_at
          ? new Date(row.updated_at).getTime() + AGENT_EDIT_HIGHLIGHT_MS
          : Infinity;
      const expired = highlightExpiry <= now;
      if (row.cursor && !expired)
        nextExpiry = Math.min(nextExpiry, highlightExpiry);
      encoding.writeVarUint(packet, presenceId(row.session_id));
      // Reserve the next clock for local highlight expiry. Older query rows
      // cannot restore a faded highlight, and the next real edit still wins.
      encoding.writeVarUint(
        packet,
        Number(row.cursor_version) * 2 + (expired ? 1 : 0),
      );
      encoding.writeVarString(
        packet,
        JSON.stringify({
          cursor: row.activity === "Idle" || expired ? null : row.cursor,
          user: {
            name: `${row.label}${row.kind === "agent" ? " · agent" : row.user_id === this.userId ? " · another tab" : ""}`,
            color: sessionColor(row.session_id),
            kind: row.kind,
          },
        }),
      );
    }
    applyAwarenessUpdate(
      this.awareness,
      encoding.toUint8Array(packet),
      "presence",
    );
    if (Number.isFinite(nextExpiry))
      this.highlightTimer = setTimeout(
        () => this.sync(remote, now + Date.now() - syncedAt),
        nextExpiry - now,
      );
  }
  destroy() {
    clearTimeout(this.highlightTimer);
    this.awareness.destroy();
  }
}
