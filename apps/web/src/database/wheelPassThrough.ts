// Inline-Datenbanken in Seiten: Wer die Seite scrollt und dabei über eine Inline-DB kommt, soll weiter die Seite
// scrollen und nicht plötzlich in der Tabelle landen (Elija 11.11.). Senkrechtes Rad/Trackpad geht deshalb an den
// nächsten scrollbaren Vorfahren, bis die Datenbank angeklickt wurde („aktiv“); seitliches Scrollen bleibt in der
// Tabelle. Verlässt der Zeiger die Datenbank, ist sie wieder inaktiv.

/** Nächster senkrecht scrollbarer Vorfahr (oder das Dokument). */
export function pageScroller(from: Element): Element {
  let el: Element | null = from.parentElement;
  while (el) {
    const s = getComputedStyle(el);
    if ((s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight) return el;
    el = el.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

/** Entscheidung als reine Funktion (getestet): Rad an die Seite weiterreichen? */
export function passWheelToPage(e: { deltaX: number; deltaY: number; ctrlKey: boolean }, active: boolean): boolean {
  if (active || e.ctrlKey) return false; // aktiv: Tabelle scrollt selbst; ctrl = Pinch-Zoom
  return Math.abs(e.deltaY) > Math.abs(e.deltaX);
}

/** Hängt das Verhalten an `root`; Rückgabe räumt auf. */
export function attachWheelPassThrough(root: HTMLElement): () => void {
  let active = false;
  const onDown = () => { active = true; root.dataset.dbActive = ""; };
  const onLeave = () => { active = false; delete root.dataset.dbActive; };
  const onWheel = (e: WheelEvent) => {
    // BSD-374: eine laufende Geste, die schon umgeleitet wurde (shell/wheelLatch.ts), nicht ein zweites Mal rollen.
    if (e.defaultPrevented || !passWheelToPage(e, active)) return;
    const target = pageScroller(root);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? target.clientHeight : 1;
    e.preventDefault();
    target.scrollBy({ top: e.deltaY * unit, left: 0, behavior: "instant" as ScrollBehavior });
  };
  root.addEventListener("pointerdown", onDown);
  root.addEventListener("pointerleave", onLeave);
  root.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    root.removeEventListener("pointerdown", onDown);
    root.removeEventListener("pointerleave", onLeave);
    root.removeEventListener("wheel", onWheel);
  };
}
