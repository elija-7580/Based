// BSD-374: Mausrad/Trackpad wie macOS „latching“: Eine Scroll-Geste bleibt an dem Bereich, in dem sie begonnen hat.
// Kommt der Zeiger während des Rollens über ein Feld mit eigenem Scrollbereich (Log in den Einstellungen, Codeblock,
// Tabelle), rollt weiter der äußere Bereich – das innere Feld fängt die laufende Geste nicht ab. Erst eine neue Geste
// (nach einer kurzen Pause ohne wheel-Ereignis) beginnt im inneren Feld. Pinch-Zoom (ctrl) bleibt unberührt.

/** Pause in ms, nach der ein wheel-Ereignis eine neue Geste beginnt (macOS liegt bei etwa 100–200 ms). */
export const LATCH_MS = 150;

export interface LatchState<T> {
  target: T | null;
  last: number;
}

/**
 * Entscheidung als reine Funktion: Welcher Bereich rollt dieses Ereignis? `natural` ist der Bereich, den der Browser
 * nehmen würde. Gibt den neuen Zustand und – falls umgeleitet werden muss – das Ziel zurück.
 */
export function latch<T>(state: LatchState<T>, now: number, natural: T, alive: (t: T) => boolean = () => true, ms = LATCH_MS): { state: LatchState<T>; redirect: T | null } {
  const held = state.target !== null && now - state.last < ms && alive(state.target) ? state.target : null;
  if (held === null) return { state: { target: natural, last: now }, redirect: null };
  return { state: { target: held, last: now }, redirect: held === natural ? null : held };
}

const scrollable = (v: string) => v === "auto" || v === "scroll" || v === "overlay";

/** Nächster Vorfahr (ab `from`), der in Richtung (dx, dy) noch rollen kann; sonst das Dokument. */
export function scrollerFor(from: Element | null, dx: number, dy: number): Element {
  const root = document.scrollingElement ?? document.documentElement;
  for (let el = from; el && el !== root; el = el.parentElement) {
    const s = getComputedStyle(el);
    const vertical = Math.abs(dy) >= Math.abs(dx);
    if (vertical) {
      if (!scrollable(s.overflowY) || el.scrollHeight - el.clientHeight < 1) continue;
      if (dy < 0 ? el.scrollTop > 0 : el.scrollTop < el.scrollHeight - el.clientHeight - 1) return el;
    } else {
      if (!scrollable(s.overflowX) || el.scrollWidth - el.clientWidth < 1) continue;
      if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft < el.scrollWidth - el.clientWidth - 1) return el;
    }
  }
  return root;
}

/** Hängt das Verhalten ans Fenster; Rückgabe räumt auf. */
export function installWheelLatch(win: Window = window): () => void {
  let state: LatchState<Element> = { target: null, last: -Infinity };
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.defaultPrevented) return;
    const natural = scrollerFor(e.target instanceof Element ? e.target : null, e.deltaX, e.deltaY);
    // Tests unter Last (zwei Browser parallel) dürfen die Pause verlängern: `__basedWheelLatchMs`.
    const ms = (globalThis as { __basedWheelLatchMs?: unknown }).__basedWheelLatchMs;
    const r = latch(state, e.timeStamp, natural, (t) => t.isConnected, typeof ms === "number" ? ms : LATCH_MS);
    state = r.state;
    if (!r.redirect) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.redirect.clientHeight : 1;
    r.redirect.scrollBy({ left: e.deltaX * unit, top: e.deltaY * unit, behavior: "instant" as ScrollBehavior });
  };
  win.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => win.removeEventListener("wheel", onWheel, { capture: true });
}
