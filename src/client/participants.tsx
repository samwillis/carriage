import { useEffect, useRef } from "react";
import { Bot, LocateFixed } from "lucide-react";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import {
  ySyncPluginKey,
  relativePositionToAbsolutePosition,
} from "y-prosemirror";
import * as Y from "yjs";
import type { DocumentProvider } from "./provider";
import type { Presence } from "../shared/contracts";
import { presenceActivity, sessionColor } from "./presence";

export function Participants({
  provider,
  rows,
  editor,
}: {
  provider: DocumentProvider;
  rows: Presence[];
  editor: Editor | null;
}) {
  const panel = useRef<HTMLDetailsElement>(null);
  const others = rows.filter((row) => row.session_id !== provider.sessionId);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node))
        panel.current.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  if (!others.length) return null;
  const description = (row: Presence) =>
    `${row.label}${row.kind === "agent" ? " · agent" : row.user_id === provider.session.userId ? " · your other session" : ""} · ${presenceActivity(row)}`;
  const avatar = (row: Presence) => (
    <span
      className={`avatar ${row.kind === "agent" ? "agent" : ""} ${row.activity === "Idle" ? "idle" : ""}`}
      style={{
        color: sessionColor(row.session_id),
        backgroundColor: `${sessionColor(row.session_id)}18`,
        borderColor: sessionColor(row.session_id),
      }}
    >
      {row.kind === "agent" ? (
        <Bot size={14} />
      ) : (
        row.label.slice(0, 1).toUpperCase()
      )}
    </span>
  );
  function locate(row: Presence) {
    if (!row.cursor || !editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx),
        binding = ySyncPluginKey.getState(view.state);
      const pos = relativePositionToAbsolutePosition(
        provider.doc,
        binding.type,
        Y.createRelativePositionFromJSON(row.cursor!.head),
        binding.binding.mapping,
      );
      if (pos === null) return;
      const { node } = view.domAtPos(
        Math.min(pos, view.state.doc.content.size),
      );
      (node instanceof Element ? node : node.parentElement)?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    });
    if (panel.current) panel.current.open = false;
  }
  return (
    <details
      ref={panel}
      className="presence-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape" && panel.current) {
          panel.current.open = false;
          panel.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary
        className="presence"
        aria-label={`${others.length + 1} sessions — show participants`}
      >
        <span className="presence-avatars">
          {others.slice(0, 3).map((row) => (
            <span key={row.session_id} title={description(row)}>
              {avatar(row)}
            </span>
          ))}
        </span>
        <span className="presence-count">
          {others.length + 1}
          <span> here</span>
        </span>
      </summary>
      <div className="participants-list" role="group" aria-label="Participants">
        <div className="participant">
          <span
            className="avatar"
            style={{
              color: sessionColor(provider.sessionId),
              backgroundColor: `${sessionColor(provider.sessionId)}18`,
            }}
          >
            {provider.session.name.slice(0, 1).toUpperCase()}
          </span>
          <span>
            {provider.session.name}
            <small>You</small>
          </span>
        </div>
        {others.map((row) => (
          <div className="participant" key={row.session_id}>
            {avatar(row)}
            <span>
              {row.label}
              <small>
                {row.kind === "agent"
                  ? "Agent · "
                  : row.user_id === provider.session.userId
                    ? "Your other session · "
                    : ""}
                {presenceActivity(row)}
              </small>
            </span>
            {row.cursor && row.activity !== "Idle" && editor && (
              <button
                className="icon-button"
                title={`Find ${row.label} in document`}
                aria-label={`Find ${row.label} in document`}
                onClick={() => locate(row)}
              >
                <LocateFixed size={15} />
              </button>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
