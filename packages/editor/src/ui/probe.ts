// BSD-319: Haken für die Diagnose („Problem melden“). Die Web-Shell setzt einmal eine Sonde; jeder Editor meldet sich
// bei ihr an, sobald seine ProseMirror-Ansicht steht, und ab, wenn er verschwindet. Ohne Sonde kostet das nichts.
// BSD-407 Teil 4: nur noch die Sonde des Block-Editors (die ProseMirror-Sonde des alten Editors ist entfernt).
import type { WorkspaceStore } from "@based/core";

// MARK: Block-Editor (ADR 0016)

/**
 * Auswahl im Block-Editor: `type` „text“ mit Block und Offsets (UTF-16 wie der Kern), „blocks“ (Blockauswahl) oder
 * „none“. Gleiche Form wie `SelectionInfo` aus @based/core.
 */
export interface BlockProbeSelection { type: string; anchor: number; head: number; block?: string; blocks?: string[] }

export interface BlockEditorProbeTarget {
  /** Seite, deren Blöcke der Editor zeigt. */
  rootID: string;
  store: WorkspaceStore;
  /** Schreibmarke bzw. Blockauswahl jetzt (aus dem DOM, ändert nichts). */
  selection(): BlockProbeSelection;
  /** Schreibmarke oder Blockauswahl setzen (Wiedergabe); `false`, wenn der Block fehlt. */
  setSelection(sel: BlockProbeSelection): boolean;
  selectedBlocks(): readonly string[];
}

export type BlockEditorProbe = (target: BlockEditorProbeTarget) => (() => void) | void;

let blockProbe: BlockEditorProbe | undefined;

/** Sonde für Block-Editoren (einmal beim Start der App); `undefined` nimmt sie weg. */
export function setBlockEditorProbe(p: BlockEditorProbe | undefined) {
  blockProbe = p;
}

/** Aus dem Block-Editor beim Einhängen; gibt die Abmeldung zurück. Ohne Sonde kostet das nichts. */
export function attachBlockEditorProbe(t: BlockEditorProbeTarget): () => void {
  const off = blockProbe?.(t);
  return () => off?.();
}
