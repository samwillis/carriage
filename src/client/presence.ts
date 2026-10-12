import type * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import { cursorSelection, type Presence } from "../shared/contracts";

// Remote awareness IDs live above Yjs's uint32 document client IDs. The
// authenticated session row owns this ID; callers never supply awareness IDs.
export function presenceId(sessionId: string) {
  return Number.parseInt(`1${sessionId.replaceAll("-", "").slice(0, 12)}`, 16);
}
export function sessionColor(sessionId: string) {
  const hex = sessionId.replaceAll("-", "");
  return `#${[0, 2, 4].map((offset) => (40 + (Number.parseInt(hex.slice(offset, offset + 2), 16) % 80)).toString(16).padStart(2, "0")).join("")}`;
}
export class PresenceAwareness {
  readonly awareness: Awareness;
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
    const remote = rows.filter(
      (row) =>
        row.kind === "person" &&
        row.session_id !== this.sessionId &&
        new Date(row.expires_at).getTime() > now,
    );
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
      encoding.writeVarUint(packet, presenceId(row.session_id));
      encoding.writeVarUint(packet, Number(row.cursor_version));
      encoding.writeVarString(
        packet,
        JSON.stringify({
          cursor: row.cursor,
          user: {
            name: `${row.label}${row.user_id === this.userId ? " · another tab" : ""}`,
            color: sessionColor(row.session_id),
          },
        }),
      );
    }
    applyAwarenessUpdate(
      this.awareness,
      encoding.toUint8Array(packet),
      "presence",
    );
  }
  destroy() {
    this.awareness.destroy();
  }
}
