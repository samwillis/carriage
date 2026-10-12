import { useEffect, useRef } from "react";
import {
  Editor,
  rootCtx,
  editorViewCtx,
  editorViewOptionsCtx,
} from "@milkdown/kit/core";
import {
  commonmark,
  toggleStrongCommand,
  toggleEmphasisCommand,
  wrapInHeadingCommand,
  wrapInBulletListCommand,
} from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { $prose, callCommand } from "@milkdown/kit/utils";
import { keymap } from "@milkdown/kit/prose/keymap";
import {
  ySyncPlugin,
  yUndoPlugin,
  undoCommand,
  redoCommand,
} from "y-prosemirror";
import type { DocumentProvider } from "./provider";
export type Format = "bold" | "italic" | "heading" | "list" | "undo" | "redo";
export function WritingEditor({
  provider,
  readOnly,
  onEditor,
}: {
  provider: DocumentProvider;
  readOnly: boolean;
  onEditor: (editor: Editor | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const writable = useRef(!readOnly);
  writable.current = !readOnly;
  useEffect(() => {
    let cancelled = false;
    let created = false;
    const instance = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, host.current!);
        ctx.update(editorViewOptionsCtx, (options) => ({
          ...options,
          editable: () => writable.current,
          attributes: {
            "aria-label": "Document editor",
            "data-testid": "document-editor",
          },
        }));
      })
      .use(commonmark)
      .use(gfm)
      .use(
        $prose(() => ySyncPlugin(provider.doc.getXmlFragment("prosemirror"))),
      )
      .use($prose(() => yUndoPlugin()))
      .use(
        $prose(() =>
          keymap({
            "Mod-z": undoCommand,
            "Mod-y": redoCommand,
            "Mod-Shift-z": redoCommand,
          }),
        ),
      );
    void instance.create().then(() => {
      created = true;
      if (cancelled) void instance.destroy();
      else {
        editor.current = instance;
        onEditor(instance);
      }
    });
    return () => {
      cancelled = true;
      onEditor(null);
      editor.current = null;
      if (created) void instance.destroy();
    };
  }, [provider]);
  useEffect(() => {
    editor.current?.action((ctx) =>
      ctx.get(editorViewCtx).setProps({ editable: () => !readOnly }),
    );
  }, [readOnly]);
  return <div ref={host} className="editor-root" />;
}
export function format(editor: Editor | null, action: Format) {
  if (!editor) return;
  editor.action((ctx) => ctx.get(editorViewCtx).focus());
  if (action === "undo" || action === "redo")
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      (action === "undo" ? undoCommand : redoCommand)(
        view.state,
        view.dispatch,
      );
    });
  else if (action === "bold")
    editor.action(callCommand(toggleStrongCommand.key));
  else if (action === "italic")
    editor.action(callCommand(toggleEmphasisCommand.key));
  else if (action === "heading")
    editor.action(callCommand(wrapInHeadingCommand.key, 2));
  else editor.action(callCommand(wrapInBulletListCommand.key));
}
