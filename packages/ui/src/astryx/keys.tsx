// Tastenkürzel als Tastenkappe (docs/design/elements.md): eine flache Kappe je Kombination („⇧⌘K“ bzw. „Ctrl+Shift+K“),
// überall dieselbe – Menü, Tooltip, Seitenleiste, Übersicht, ⌘-Anzeige. Nimmt die Schreibweise des Tastatur-Registers
// („Mod+Shift+K“, mehrere mit „ / “).
import { Fragment } from "react";
import { comboKeys, comboLabel, parseCombo } from "../keys.js";

const KBD_KEY: Record<string, string> = { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", "+": "plus", arrows: "↑↓←→" };

/** Register-Schreibweise → „mod+shift+k“ (für Bausteine, die Tasten einzeln brauchen). */
export function kbdKeys(combo: string): string {
  const c = parseCombo(combo);
  return [...(c.mod ? ["mod"] : []), ...(c.ctrl ? ["ctrl"] : []), ...(c.alt ? ["alt"] : []), ...(c.shift ? ["shift"] : []), KBD_KEY[c.key] ?? c.key].join("+");
}

const apple = (): boolean => {
  const nav = (globalThis.navigator ?? {}) as { platform?: string; userAgent?: string };
  return /Mac|iPhone|iPad/.test(nav.platform ?? "") || /Mac OS X|iPhone|iPad/.test(nav.userAgent ?? "");
};

export function BasedKeys({ keys }: { keys: string }) {
  const mac = apple();
  const all = keys.split(" / ");
  const spoken = all.map((k) => comboKeys(k, mac).join(" + ")).join(" or ");
  return (
    <span className="keycaps" role="img" aria-label={spoken}>
      {all.map((k) => <Fragment key={k}><kbd className="keycap" aria-hidden="true">{comboLabel(k, mac)}</kbd></Fragment>)}
    </span>
  );
}
