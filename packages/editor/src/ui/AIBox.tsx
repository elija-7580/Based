// BSD-225: „Ask AI“ im Editor (Swift InlineAIBox.swift): auf leerer Zeile (Leertaste oder /AI) schreiben lassen, mit
// markiertem Text (Formatleiste) umschreiben. Vorschau → Insert / Replace / Try again / Discard; Einfügen ist ein
// Undo-Schritt. Welches Modell antwortet, entscheidet die Shell (`EditorAI`, BSD-159-Engines).
import { useEffect, useRef, useState } from "react";
import { TextSelection } from "prosemirror-state";
import type { BasedEditor } from "../schema/schema.js";
import { insertMarkdown } from "./paste.js";
import { SELECTION_ACTIONS, type EditorAI } from "./ai.js";

export { SELECTION_ACTIONS, type EditorAI } from "./ai.js";

export interface AIRequest {
  editor: BasedEditor;
  /** Block, unter/an dem eingefügt wird. */
  blockID: string;
  /** Markierter Text und seine Lage im Dokument (Ersetzen). */
  selection?: { text: string; from: number; to: number } | undefined;
  /** Text der Seite (Kontext). */
  page: string;
  /** Lage am Bildschirm (unter dem Block). */
  x: number;
  y: number;
}


/** Ergebnis an der Stelle einfügen: ersetzt die Auswahl oder kommt unter den Block. Ein Undo-Schritt. */
export function applyAIResult(req: AIRequest, text: string, mode: "replace" | "below"): boolean {
  const { editor } = req;
  const md = text.trim();
  if (!md) return false;
  if (mode === "replace" && req.selection) {
    const view = editor.prosemirrorView;
    if (!view) return false;
    const size = view.state.doc.content.size;
    const from = Math.min(req.selection.from, size), to = Math.min(req.selection.to, size);
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    return insertMarkdown(editor, md);
  }
  try {
    editor.setTextCursorPosition(req.blockID, "end");
  } catch { /* Block ohne Text: nach ihm einfügen */ }
  const cur = editor.getTextCursorPosition().block;
  const empty = cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0;
  if (!empty) {
    editor.insertBlocks([{ type: "paragraph" } as never], cur, "after");
    const next = editor.getNextBlock(cur.id);
    if (next) editor.setTextCursorPosition(next, "start");
  }
  return insertMarkdown(editor, md);
}

export function AIBox({ ai, req, onClose }: { ai: EditorAI; req: AIRequest; onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [state, setState] = useState<{ phase: "ask" } | { phase: "busy"; prompt: string } | { phase: "done"; prompt: string; text: string } | { phase: "failed"; prompt: string; message: string }>({ phase: "ask" });
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => () => abort.current?.abort(), []);
  const run = (p: string) => {
    if (!p.trim()) return;
    abort.current?.abort();
    const ctl = (abort.current = new AbortController());
    setState({ phase: "busy", prompt: p });
    ai.write({ prompt: p, selection: req.selection?.text, page: req.page }, ctl.signal).then(
      (text) => { if (!ctl.signal.aborted) setState({ phase: "done", prompt: p, text }); },
      (e: unknown) => { if (!ctl.signal.aborted) setState({ phase: "failed", prompt: p, message: e instanceof Error ? e.message : String(e) }); },
    );
  };
  const finish = (mode: "replace" | "below") => {
    if (state.phase !== "done") return;
    onClose();
    applyAIResult(req, state.text, mode);
  };
  const discard = () => { abort.current?.abort(); onClose(); };
  return (
    <div className="bx-ai" role="dialog" aria-label="Ask AI" data-testid="ai-box" style={{ left: req.x, top: req.y }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); discard(); } }}>
      {state.phase === "ask" ? (
        <>
          <input ref={input} className="bx-field bx-ai-input" aria-label="Ask AI" placeholder={req.selection ? "Ask AI to edit…" : "Ask AI to write…"} value={prompt}
            onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); run(prompt); } }} />
          {req.selection ? (
            <div className="bx-ai-actions" role="group" aria-label="Edit selection">
              {SELECTION_ACTIONS.map((a) => <button key={a.label} type="button" className="bx-ai-action" onClick={() => run(a.prompt)}>{a.label}</button>)}
            </div>
          ) : null}
        </>
      ) : state.phase === "busy" ? (
        <p className="bx-ai-status" role="status" aria-busy="true">Writing…<button type="button" className="bx-ai-action" onClick={discard}>Stop</button></p>
      ) : state.phase === "failed" ? (
        <>
          <p className="bx-ai-status" role="alert">{state.message}</p>
          <div className="bx-ai-actions"><button type="button" className="bx-ai-action" onClick={() => run(state.prompt)}>Try again</button><button type="button" className="bx-ai-action" onClick={discard}>Discard</button></div>
        </>
      ) : (
        <>
          <div className="bx-ai-preview" data-testid="ai-preview">{state.text}</div>
          <div className="bx-ai-actions">
            {req.selection ? <button type="button" className="bx-ai-action primary" onClick={() => finish("replace")}>Replace selection</button> : null}
            <button type="button" className={"bx-ai-action" + (req.selection ? "" : " primary")} onClick={() => finish("below")}>{req.selection ? "Insert below" : "Insert"}</button>
            <button type="button" className="bx-ai-action" onClick={() => run(state.prompt)}>Try again</button>
            <button type="button" className="bx-ai-action" onClick={discard}>Discard</button>
          </div>
        </>
      )}
    </div>
  );
}
