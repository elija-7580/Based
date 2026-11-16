// BSD-421: Leisten und Fenster, die ein Kurzbefehl öffnet (⌘F, ⌘K/⌘P, ⌘N), geben beim Schließen – auch über denselben
// Kurzbefehl – den Fokus dorthin zurück, wo er vorher war; im Editor samt Schreibmarke/Markierung (ein bloßes focus()
// setzte sie an den Anfang des Blocks).
import { useEffect, useRef, useState } from "react";

interface Saved { el: HTMLElement; range: Range | undefined }

/** Fokus und (falls darin) die Markierung jetzt merken. */
export function saveFocus(doc: Document = document): Saved | undefined {
  const el = doc.activeElement;
  if (!(el instanceof HTMLElement) || el === doc.body) return undefined;
  const sel = doc.getSelection();
  const range = sel && sel.rangeCount && el.isContentEditable && el.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0).cloneRange() : undefined;
  return { el, range };
}

/** Gemerkten Fokus wiederherstellen – nur wenn der Fokus gerade „verloren“ ist (body oder im geschlossenen Element). */
export function restoreFocus(saved: Saved | undefined, doc: Document = document): void {
  if (!saved || !saved.el.isConnected) return;
  const now = doc.activeElement;
  if (now && now !== doc.body && now.isConnected) return;
  saved.el.focus({ preventScroll: true });
  if (saved.range) {
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(saved.range);
  }
}

/** Beim ersten Zeichnen merken (vor dem Fokus ins eigene Feld), nach dem Aushängen zurückgeben.
 *  BSD-438: `skip()` → true beim Aushängen (z. B. eine Seite wurde geöffnet) → nichts zurückgeben, das Ziel bestimmt den
 *  Fokus (BSD-304). */
export function useRestoreFocus(skip?: () => boolean): void {
  const [saved] = useState(() => (typeof document === "undefined" ? undefined : saveFocus()));
  const skipRef = useRef(skip);
  skipRef.current = skip;
  useEffect(() => () => {
    if (skipRef.current?.()) return;
    queueMicrotask(() => restoreFocus(saved));
  }, [saved]);
}
