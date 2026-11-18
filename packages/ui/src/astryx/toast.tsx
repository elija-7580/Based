// Hinweis, Anzeige (docs/design/elements.md, Abschnitte 4 und 5): unten Mitte, 24 px vom Rand, Fläche und Schatten wie
// das Menü, eine zur Zeit. Kommt in 180 ms mit 8 px von unten, geht nach 4 s oder wenn der Anlass endet
// (`open` = false). Keine eigene Animation: Übergang mit @starting-style (elements.css).
import { useEffect, type ReactNode } from "react";

export const TOAST_MS = 4000;

export interface BasedToastProps {
  open: boolean;
  /** Schließt nach 4 s von selbst; ohne `onClose` bleibt der Hinweis, bis `open` false wird (z. B. Taste losgelassen). */
  onClose?: () => void;
  children: ReactNode;
  /** Knopf rechts (z. B. „Undo“). */
  action?: ReactNode;
  testID?: string;
}

export function BasedToast({ open, onClose, children, action, testID }: BasedToastProps) {
  useEffect(() => {
    if (!open || !onClose) return;
    const t = setTimeout(onClose, TOAST_MS);
    return () => clearTimeout(t);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <output className="based-toast" role="status" aria-live="polite" data-testid={testID}>
      <span className="based-toast-body">{children}</span>
      {action}
    </output>
  );
}
