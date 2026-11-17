// Tastenkombinationen als Text („Mod+Shift+K“): eine Schreibweise für Register, Anzeige (⇧⌘K bzw. Ctrl+Shift+K),
// Abgleich mit Tastaturereignissen und das Mac-Menü (Tauri-Accelerator). Rein, ohne DOM.
// „Mod“ = ⌘ auf Apple, Strg sonst. Reihenfolge der Zusätze egal; die Taste steht zuletzt.

export interface Combo {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  /** Taste in Kleinbuchstaben („k“, „/“, „enter“, „arrowup“, „f6“). */
  key: string;
}

export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export function parseCombo(text: string): Combo {
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  // „Mod++“ o. ä.: ein abschließendes „+“ ist die Taste selbst
  const key = text.trim().endsWith("+") ? "+" : (parts.pop() ?? "");
  const has = (n: string) => parts.some((p) => p.toLowerCase() === n);
  return { mod: has("mod"), ctrl: has("ctrl"), shift: has("shift"), alt: has("alt"), key: key.toLowerCase() };
}

const CODE_OF: Record<string, string> = {
  "/": "Slash", "\\": "Backslash", "[": "BracketLeft", "]": "BracketRight", ",": "Comma", ".": "Period",
  ";": "Semicolon", "'": "Quote", "-": "Minus", "=": "Equal", "`": "Backquote",
};

/** Physische Taste (KeyboardEvent.code) zu einer Taste des Registers – nötig, weil ⌥/⇧ `key` verändern. */
export function codeOf(key: string): string | undefined {
  if (/^[a-z]$/.test(key)) return "Key" + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return "Digit" + key;
  return CODE_OF[key];
}

/** Trifft das Ereignis die Kombination? `apple` entscheidet, ob „Mod“ ⌘ oder Strg ist. */
export function matchCombo(e: KeyEventLike, c: Combo, apple: boolean): boolean {
  const mod = apple ? e.metaKey : e.ctrlKey;
  const ctrl = apple ? e.ctrlKey : false;
  if (mod !== c.mod || e.altKey !== c.alt || e.shiftKey !== c.shift) return false;
  if (apple && ctrl !== c.ctrl) return false;
  const code = codeOf(c.key);
  if (code && e.code) return e.code === code;
  return e.key.toLowerCase() === c.key;
}

const APPLE_KEY: Record<string, string> = {
  enter: "↩", escape: "esc", backspace: "⌫", delete: "⌦", tab: "⇥", space: "Space",
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", home: "↖", end: "↘", pageup: "⇞", pagedown: "⇟",
};
const PLAIN_KEY: Record<string, string> = {
  enter: "Enter", escape: "Esc", backspace: "Backspace", delete: "Del", tab: "Tab", space: "Space",
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", home: "Home", end: "End", pageup: "PgUp", pagedown: "PgDn",
};

/** Einzelne Tastenkappen für die Anzeige: ["⇧", "⌘", "K"] bzw. ["Ctrl", "Shift", "K"]. */
export function comboKeys(text: string, apple: boolean): string[] {
  const c = parseCombo(text);
  const name = (c.key === "arrows" ? "↑↓←→" : undefined) ?? (apple ? APPLE_KEY : PLAIN_KEY)[c.key] ?? (/^f\d+$/.test(c.key) ? c.key.toUpperCase() : c.key.length === 1 ? c.key.toUpperCase() : c.key);
  // ⇧⌘/ liest sich als ⌘? – so steht es auch auf der Taste
  if (apple) return [...(c.ctrl ? ["⌃"] : []), ...(c.alt ? ["⌥"] : []), ...(c.shift ? ["⇧"] : []), ...(c.mod ? ["⌘"] : []), name];
  return [...(c.mod || c.ctrl ? ["Ctrl"] : []), ...(c.alt ? ["Alt"] : []), ...(c.shift ? ["Shift"] : []), name];
}

/** „⇧⌘K“ bzw. „Ctrl+Shift+K“. Mehrere Kombinationen mit „ / “ getrennt angeben („ArrowUp / ArrowDown“). */
export function comboLabel(text: string, apple: boolean): string {
  return text.split(" / ").map((t) => comboKeys(t, apple).join(apple ? "" : "+")).join(" / ");
}

const ACCEL_KEY: Record<string, string> = {
  enter: "Enter", escape: "Escape", backspace: "Backspace", delete: "Delete", tab: "Tab", space: "Space",
  arrowup: "Up", arrowdown: "Down", arrowleft: "Left", arrowright: "Right",
};

/** Tauri-/muda-Accelerator: „CmdOrCtrl+Shift+K“. */
export function comboAccelerator(text: string): string {
  const c = parseCombo(text);
  const key = ACCEL_KEY[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key.toUpperCase());
  return [...(c.mod ? ["CmdOrCtrl"] : []), ...(c.ctrl ? ["Ctrl"] : []), ...(c.alt ? ["Alt"] : []), ...(c.shift ? ["Shift"] : []), key].join("+");
}
