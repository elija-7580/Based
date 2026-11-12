// BSD-204: App-weite Tastaturkürzel als reine Zuordnung Taste → Aktion (getestet in shortcuts.test.ts). ⌘ auf Apple,
// Strg sonst. Im normalen Browser-Tab behält der Browser einige für sich (⌘N neues Fenster, ⌘T/⌘W, ⌘1–9 in
// Chrome/Safari); in der App (Tauri), als PWA und in Tests kommen sie an. ⌘P ist im Browser abfangbar (sonst Drucken).

export type ShortcutAction =
  | { kind: "quickFind" }
  | { kind: "palette" }
  | { kind: "newPage" }
  | { kind: "settings" }
  | { kind: "toggleTheme" }
  | { kind: "newTab" }
  | { kind: "closeTab" }
  | { kind: "cycleTab"; delta: 1 | -1 }
  | { kind: "tab"; index: number } // 0-basiert, -1 = letzter (⌘9 wie im Browser)
  | { kind: "back" }
  | { kind: "forward" }
  /** BSD-168: ⇧⌘U öffnet die Elternseite (Swift „Open Parent Page“). */
  | { kind: "openParent" }
  /** BSD-206: Suchen in der Seite (⌘F), nächste/vorige Fundstelle (⌘G / ⇧⌘G). */
  | { kind: "find" }
  | { kind: "findStep"; delta: 1 | -1 }
  /** BSD-319: „Problem melden“ (⇧⌘B). */
  | { kind: "reportProblem" };

/** App → Seite: ⌘F/⌘G. Die Seite ruft `preventDefault()`, wenn sie die Taste nimmt. */
export const FIND_EVENT = "based:find";

export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function matchShortcut(e: KeyLike): ShortcutAction | undefined {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return undefined;
  const k = e.key.toLowerCase();
  const code = e.code ?? "";
  // ⌥ verändert e.key auf dem Mac (⌥N → „˜“): für ⌥⌘N den physischen Code nehmen.
  if (e.altKey && !e.shiftKey && (code === "KeyN" || k === "n")) return { kind: "newPage" };
  if (e.altKey) return undefined;
  if (e.shiftKey) {
    if (code === "KeyL" || k === "l") return { kind: "toggleTheme" };
    if (code === "KeyG" || k === "g") return { kind: "findStep", delta: -1 };
    if (code === "KeyB" || k === "b") return { kind: "reportProblem" };
    if (code === "KeyU" || k === "u") return { kind: "openParent" };
    if (code === "BracketLeft" || code === "BracketRight") return { kind: "cycleTab", delta: code === "BracketRight" ? 1 : -1 };
    return undefined;
  }
  if (k === "k" || k === "p") return { kind: "quickFind" };
  if (k === "n") return { kind: "palette" };
  if (k === ",") return { kind: "settings" };
  if (k === "t") return { kind: "newTab" };
  if (k === "w") return { kind: "closeTab" };
  if (k === "f") return { kind: "find" };
  if (k === "g") return { kind: "findStep", delta: 1 };
  if (k === "[") return { kind: "back" };
  if (k === "]") return { kind: "forward" };
  const digit = /^Digit([1-9])$/.exec(code)?.[1] ?? (/^[1-9]$/.test(k) ? k : undefined);
  if (digit) return { kind: "tab", index: digit === "9" ? -1 : Number(digit) - 1 };
  return undefined;
}

/** BSD-168: Ziel von ⇧⌘U – die Elternseite laut Seitenleisten-Struktur; oberste Seiten haben keine. */
export function parentPage(outline: { nodes: Readonly<Record<string, { parent?: string | undefined } | undefined>> } | undefined, id: string): string | undefined {
  const parent = outline?.nodes[id]?.parent;
  return parent && outline?.nodes[parent] ? parent : undefined;
}
