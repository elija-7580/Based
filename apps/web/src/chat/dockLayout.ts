// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-607 (Entscheidung Elija 19.11.: „wie die seitenleiste links“): Würde das offene Chat-Panel die Hauptspalte unter
// MAIN_MIN stauchen (z. B. 900 × 600 mit Seitenleiste: nur ~236 px), schwebt es über dem Inhalt – wie die
// eingeklappte Seitenleiste unter 860 px (BSD-309, components/Sidebar.tsx) – statt Platz zu nehmen. Die Hauptspalte
// behält dann ihre Breite. Unter 760 px deckt das Panel ohnehin das ganze Fenster (chat.css), dort gilt das nicht.
import { useEffect, useState } from "react";

/** Mindestbreite der Hauptspalte neben dem Panel – so breit wie ein Seitenblatt (`BasedSheet`, elements.md) bzw.
 *  die breiteste Seitenleiste (SIDEBAR_MAX). */
export const MAIN_MIN = 480;
/** Fensterbreite, ab der das Panel das ganze Fenster deckt (chat.css, @media max-width: 760px). */
export const FULL_WINDOW = "(max-width: 760px)";

/** Schwebt das Panel? `sidebar` ist die Breite, die die Seitenleiste gerade einnimmt (0 = eingeklappt). */
export function chatFloats(windowWidth: number, sidebar: number, chat: number, fullWindow = false): boolean {
  if (fullWindow) return false;
  return windowWidth - sidebar - chat < MAIN_MIN;
}

/** Breite, die die Seitenleiste einnimmt – aus dem, was Sidebar.tsx auf <html> schreibt (applySidebar). */
export function sidebarSpace(root: HTMLElement): number {
  if (root.dataset.sidebar === "hidden") return 0;
  const w = parseFloat(root.style.getPropertyValue("--sidebar-current"));
  return Number.isFinite(w) ? w : 0;
}

/** Liest Fensterbreite und Seitenleiste laufend nach und meldet, ob das Panel der Breite `chat` schwebt. */
export function useChatFloats(chat: number): boolean {
  const compute = () => {
    const doc = globalThis.document;
    if (!doc) return false;
    return chatFloats(globalThis.innerWidth, sidebarSpace(doc.documentElement), chat, globalThis.matchMedia?.(FULL_WINDOW).matches ?? false);
  };
  const [floats, setFloats] = useState(compute);
  useEffect(() => {
    const f = () => setFloats(compute());
    f();
    globalThis.addEventListener("resize", f);
    const mo = new MutationObserver(f);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-sidebar"] });
    return () => {
      globalThis.removeEventListener("resize", f);
      mo.disconnect();
    };
  }, [chat]);
  return floats;
}
