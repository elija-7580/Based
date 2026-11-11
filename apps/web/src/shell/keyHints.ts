// BSD-270: Kürzel-Plaketten erst beim langen Halten von ⌘ (Strg) – die Halte-Erkennung kommt aus @based/ui
// (holdKey.ts, getestet); hier nur das Ein-/Ausblenden über `data-show-keys` am Wurzelelement, auf das die CSS hört.
import { holdDetector, shortcutLabel } from "@based/ui";

export const isApple = (nav: { platform?: string; userAgent?: string } = globalThis.navigator ?? {}) => /Mac|iPhone|iPad/.test(nav.platform ?? "") || /Mac OS X|iPhone|iPad/.test(nav.userAgent ?? "");

/** „⌘K“ bzw. „Ctrl+K“ für die Plaketten. */
export const keyLabel = (key: string, shift = false) => shortcutLabel(key, { apple: isApple(), shift });

export function installKeyHints(win: Window = window): () => void {
  const root = win.document.documentElement;
  const d = holdDetector({
    modifier: isApple(win.navigator) ? "Meta" : "Control",
    onChange: (v) => { if (v) root.setAttribute("data-show-keys", ""); else root.removeAttribute("data-show-keys"); },
  });
  const down = (e: KeyboardEvent) => d.keydown(e);
  const up = (e: KeyboardEvent) => d.keyup(e);
  const cancel = () => d.cancel();
  win.addEventListener("keydown", down, true);
  win.addEventListener("keyup", up, true);
  win.addEventListener("blur", cancel);
  win.addEventListener("pointerdown", cancel, true);
  win.document.addEventListener("visibilitychange", cancel);
  return () => {
    win.removeEventListener("keydown", down, true);
    win.removeEventListener("keyup", up, true);
    win.removeEventListener("blur", cancel);
    win.removeEventListener("pointerdown", cancel, true);
    win.document.removeEventListener("visibilitychange", cancel);
    cancel();
  };
}
