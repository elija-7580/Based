// BSD-319: Haken für die Diagnose („Problem melden“). Die Web-Shell setzt einmal eine Sonde; jeder Editor meldet sich
// bei ihr an, sobald seine ProseMirror-Ansicht steht, und ab, wenn er verschwindet. Ohne Sonde kostet das nichts.
import { Node as PMNode } from "prosemirror-model";
import { AllSelection, NodeSelection, TextSelection, type Selection } from "prosemirror-state";
import { Step } from "prosemirror-transform";
import type { EditorView } from "prosemirror-view";
import type * as Y from "yjs";
import type { BasedEditor } from "../schema/schema.js";

export interface EditorProbeTarget {
  /** Dokument-Wurzel (Seite oder Synced-Block-Original). */
  rootID: string;
  editor: BasedEditor;
  view: EditorView;
  doc: Y.Doc;
  /** Markierte Blöcke der Blockauswahl (Esc). */
  selectedBlocks: () => readonly string[];
}

/** Gibt eine Abmelde-Funktion zurück. */
export type EditorProbe = (target: EditorProbeTarget) => (() => void) | void;

let probe: EditorProbe | undefined;

/** Sonde setzen (einmal beim Start der App); `undefined` nimmt sie weg. Schon offene Editoren melden sich nicht nach. */
export function setEditorProbe(p: EditorProbe | undefined) {
  probe = p;
}

/** Aus dem Editor: anmelden, sobald die Ansicht steht (BlockNote baut sie beim Einhängen). */
export function attachEditorProbe(t: Omit<EditorProbeTarget, "view">): () => void {
  if (!probe) return () => {};
  let off: (() => void) | void;
  let tries = 0;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tryAttach = () => {
    if (cancelled || !probe) return;
    let view: EditorView | undefined;
    try {
      view = t.editor.prosemirrorView;
    } catch { /* noch nicht eingehängt */ }
    if (view) {
      off = probe({ ...t, view });
      return;
    }
    if (++tries < 40) timer = setTimeout(tryAttach, 25);
  };
  tryAttach();
  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    off?.();
  };
}

// MARK: Wiedergabe (BSD-319): Dokument, Auswahl und Schritte setzen – für apps/web/e2e/replay/.


export interface ProbeSelection { type: string; anchor: number; head: number }

function selectionIn(doc: PMNode, s: ProbeSelection): Selection {
  const max = doc.content.size;
  const a = Math.max(0, Math.min(max, s.anchor)), h = Math.max(0, Math.min(max, s.head));
  if (s.type === "all") return new AllSelection(doc);
  if (s.type === "node") {
    try {
      return NodeSelection.create(doc, a);
    } catch { /* fällt auf Text zurück */ }
  }
  return TextSelection.between(doc.resolve(a), doc.resolve(h));
}

/** Ganzes Dokument ersetzen (JSON aus einem Bündel) und die Auswahl setzen. */
export function loadDocJSON(view: EditorView, json: unknown, sel: ProbeSelection) {
  const node = PMNode.fromJSON(view.state.schema, json);
  const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, node.content);
  tr.setSelection(selectionIn(tr.doc, sel));
  view.dispatch(tr);
  view.focus();
}

export function setSelectionJSON(view: EditorView, sel: ProbeSelection) {
  view.dispatch(view.state.tr.setSelection(selectionIn(view.state.doc, sel)));
  view.focus();
}

export function applyStepsJSON(view: EditorView, steps: readonly unknown[]) {
  const tr = view.state.tr;
  for (const s of steps) tr.step(Step.fromJSON(view.state.schema, s as Parameters<typeof Step.fromJSON>[1]));
  view.dispatch(tr);
}
