// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-619 (Elija 20.11.): Nach „Move to Trash“ erscheint der Hinweis „Moved to Trash · Undo“ (BasedToast, 4 s); Undo
// und ⌘Z außerhalb eines Textfelds holen die Seiten zurück (Worker-Op `restore`) und öffnen die Seite wieder, wenn sie
// beim Löschen offen war. Gemerkt wird nur das letzte Löschen; nach dem Zurückholen ist es vergessen.

export interface TrashedPages {
  ids: string[];
  /** Diese Seite war offen und wird nach dem Zurückholen wieder geöffnet. */
  reopen?: string | undefined;
  /** Zählt hoch, damit derselbe Hinweis bei erneutem Löschen neu startet. */
  seq: number;
}

let last: TrashedPages | undefined;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Seiten wurden in den Papierkorb gelegt (nachdem der Worker-Befehl abgeschickt ist). */
export function movedToTrash(ids: readonly string[], reopen?: string): void {
  if (ids.length === 0) return;
  last = { ids: [...ids], reopen, seq: ++seq };
  emit();
}

/** Das zuletzt Gelöschte (noch nicht zurückgeholt), sonst `undefined`. */
export function lastTrashed(): TrashedPages | undefined {
  return last;
}

/** Vergessen (nach dem Zurückholen). Gibt zurück, was zurückzuholen ist. */
export function takeTrashed(): TrashedPages | undefined {
  const t = last;
  last = undefined;
  if (t) emit();
  return t;
}

export function subscribeTrashed(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Satz im Hinweis: „Moved to Trash“, bei mehreren Seiten „Moved 3 pages to Trash“. */
export function trashedText(n: number): string {
  return n === 1 ? "Moved to Trash" : `Moved ${n} pages to Trash`;
}
