// Befehle aus dem Mac-Menü (lib.rs → `desktop://command` mit der Kennung aus dem Tastatur-Register): die Oberfläche
// „drückt“ die Taste des Eintrags selbst – so läuft ein Menüklick über genau denselben Weg wie die Taste, an jeder
// Stelle (App, Seitenleiste, Chat, Editor), ohne zweite Verdrahtung.
import { codeOf, parseCombo } from "@based/ui";
import { isApple } from "./keyHints.js";
import { firstCombo, KEYMAP } from "./keymap.js";

/** Tastendruck zu einer Kombination des Registers (für `dispatchEvent`). */
export function comboEvent(combo: string, apple: boolean): KeyboardEventInit {
  const c = parseCombo(combo);
  const code = codeOf(c.key);
  return {
    key: c.shift && c.key === "/" ? "?" : c.key, ...(code ? { code } : {}),
    metaKey: apple && c.mod, ctrlKey: apple ? c.ctrl : c.mod || c.ctrl, shiftKey: c.shift, altKey: c.alt,
    bubbles: true, cancelable: true,
  };
}

const signature = (e: { code?: string; key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) =>
  `${e.metaKey ? "m" : ""}${e.ctrlKey ? "c" : ""}${e.shiftKey ? "s" : ""}${e.altKey ? "a" : ""}:${e.code || e.key.toLowerCase()}`;

/**
 * Führt einen Befehl des Registers aus, indem es seine Taste drückt. Kam dieselbe Taste gerade eben schon echt von
 * der Tastatur (dann hat die Seite sie bereits verarbeitet), passiert nichts – sonst würde z. B. die Suche auf- und
 * gleich wieder zugehen, falls das Menü die Taste zusätzlich meldet.
 */
export function installCommands(win: Window = window): { run(id: string): boolean; dispose(): void } {
  const apple = isApple(win.navigator);
  let last = { sig: "", at: 0 };
  const onKey = (e: KeyboardEvent) => { if (e.isTrusted) last = { sig: signature(e), at: win.performance.now() }; };
  win.addEventListener("keydown", onKey, true);
  return {
    run(id) {
      const entry = KEYMAP.find((e) => e.id === id);
      if (!entry) return false;
      const init = comboEvent(firstCombo(entry), apple);
      if (last.sig === signature({ ...init, key: init.key!, metaKey: !!init.metaKey, ctrlKey: !!init.ctrlKey, shiftKey: !!init.shiftKey, altKey: !!init.altKey }) && win.performance.now() - last.at < 400) return false;
      const target = win.document.activeElement ?? win.document.body;
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      return true;
    },
    dispose() { win.removeEventListener("keydown", onKey, true); },
  };
}

/** Fenster-Ereignis, über das desktop.ts einen Menübefehl an die App reicht (`detail` = Kennung). */
export const COMMAND_EVENT = "based:command";
