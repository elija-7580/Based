// BSD-304: Dialoge und Auswahlen geben beim Schließen den Fokus dorthin zurück, wo er vorher war (Knopf, Zeile) –
// sonst landet er auf <body> und die Tastatur fängt oben von vorn an. Kam der Dialog aus einem Menü (die Menüzeile
// ist danach weg), geht der Fokus an das zuletzt fokussierte Element außerhalb von Menüs – meist der Menüknopf.
// Zurückgegeben wird nur, wenn der Fokus beim Schließen „verloren“ ist (body, nichts, entfernt); wer selbst woanders
// hin fokussiert (z. B. eine neue Seite), gewinnt.
import { useEffect } from "react";

/** Menüs, Listen und Dialoge sind „Überlagerungen“: dorthin wird nie zurückgegeben (sie sind beim Schließen weg). */
const inMenu = (el: Element) => !!el.closest("[role=menu], [role=listbox], [role=menuitem], .nf-layer, .menu, .menu-item, [role=dialog], [role=alertdialog], dialog");
let lastOutsideMenu: HTMLElement | null = null;
let tracking = false;
function track(doc: Document) {
  if (tracking) return;
  tracking = true;
  doc.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && t !== doc.body && !inMenu(t)) lastOutsideMenu = t;
  }, true);
}

/** Merkt sich den Fokus beim Einhängen und gibt ihn beim Aushängen zurück. */
export function useReturnFocus(): void {
  useEffect(() => {
    const doc = globalThis.document;
    if (!doc) return;
    track(doc);
    const active = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
    const before = active && !inMenu(active) ? active : lastOutsideMenu;
    return () => {
      // erst nach dem Aushängen prüfen (der Dialog ist dann aus dem DOM)
      const restore = () => {
        const target = before?.isConnected ? before : null;
        if (!target) return;
        const now = doc.activeElement;
        if (now === null || now === doc.body || !now.isConnected) target.focus({ preventScroll: true });
      };
      queueMicrotask(restore);
      // Hüllen mit Ausblend-Animation (Astryx-Dialog) setzen den Fokus erst danach auf <body> – dann noch einmal.
      setTimeout(restore, 250);
    };
  }, []);
}
