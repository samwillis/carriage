import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  PresenceAwareness,
  presenceId,
  sessionColor,
} from "../src/client/presence";
import { presenceInput, type Presence } from "../src/shared/contracts";
const own = "bdf46796-9eb9-43cf-8131-bfd72d64b558";
const other = "7621dff5-1d32-431b-8805-c575a7ed788e";
function row(cursor: Presence["cursor"], version = 1): Presence {
  return {
    session_id: other,
    user_id: "user",
    label: "Writer",
    kind: "person",
    activity: "Viewing",
    expires_at: new Date(Date.now() + 45000),
    cursor,
    cursor_version: version,
  };
}
describe("cursor presence", () => {
  it("mirrors another session on the same account without changing document state", () => {
    const doc = new Y.Doc(),
      bridge = new PresenceAwareness(doc, own, "user", "Writer");
    const before = Y.encodeStateAsUpdate(doc);
    const cursor = {
      anchor: { tname: "prosemirror" as const, assoc: 0 },
      head: { tname: "prosemirror" as const, assoc: 0 },
    };
    bridge.sync([row(cursor), { ...row(cursor), session_id: own }], Date.now());
    const remote = bridge.awareness.getStates().get(presenceId(other));
    expect(remote?.user.name).toContain("another tab");
    expect(remote?.cursor).toEqual(cursor);
    expect(remote?.user.color).not.toEqual(sessionColor(own));
    expect(bridge.awareness.getStates().size).toBe(2);
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
    bridge.destroy();
    doc.destroy();
  });
  it("retains a newer selection when older presence arrives and removes expired sessions", () => {
    const doc = new Y.Doc(),
      bridge = new PresenceAwareness(doc, own, "user", "Writer");
    const cursor = {
      anchor: { tname: "prosemirror" as const, assoc: 0 },
      head: { tname: "prosemirror" as const, assoc: 0 },
    };
    bridge.sync([row(cursor, 3)], Date.now());
    bridge.sync([row(null, 2)], Date.now());
    expect(bridge.awareness.getStates().get(presenceId(other))?.cursor).toEqual(
      cursor,
    );
    bridge.sync([{ ...row(cursor, 3), expires_at: new Date(0) }], Date.now());
    expect(bridge.awareness.getStates().has(presenceId(other))).toBe(false);
    bridge.sync([row(cursor, 4)], Date.now());
    expect(bridge.awareness.getStates().has(presenceId(other))).toBe(true);
    bridge.destroy();
    doc.destroy();
  });
  it("anchors selections to characters while concurrent edits change offsets", () => {
    const doc = new Y.Doc();
    const root = doc.getXmlFragment("prosemirror"),
      paragraph = new Y.XmlElement("paragraph"),
      text = new Y.XmlText();
    text.insert(0, "hello world");
    paragraph.insert(0, [text]);
    root.insert(0, [paragraph]);
    const anchor = Y.createRelativePositionFromTypeIndex(text, 6),
      head = Y.createRelativePositionFromTypeIndex(text, 11);
    const parsed = presenceInput.parse({
      session_id: own,
      activity: "Viewing",
      sequence: 1,
      cursor: { anchor, head },
    });
    text.insert(0, "Well, ");
    expect(
      Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(parsed.cursor!.anchor),
        doc,
      )?.index,
    ).toBe(12);
    expect(
      Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(parsed.cursor!.head),
        doc,
      )?.index,
    ).toBe(17);
    doc.destroy();
  });
  it("accepts old heartbeat payloads and bounds cursor shapes", () => {
    expect(
      presenceInput.parse({ session_id: own, activity: "Viewing" }).cursor,
    ).toBeNull();
    expect(
      presenceInput.safeParse({
        session_id: own,
        activity: "Viewing",
        cursor: { anchor: { tname: "another_root" }, head: {} },
      }).success,
    ).toBe(false);
    expect(
      presenceInput.safeParse({
        session_id: own,
        activity: "Viewing",
        sequence: -1,
      }).success,
    ).toBe(false);
  });
});
