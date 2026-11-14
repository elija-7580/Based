// BSD-168/290: Bild in voller Größe ansehen wie Notion – Doppelklick auf ein Bild im Editor öffnet die Ansicht,
// Esc, Klick daneben oder × schließen. Nur Anzeige; Breite, Caption und Ersetzen bleiben am Block.
import { useEffect, useRef } from "react";

export interface ImageView {
  src: string;
  alt: string;
}

/** Bild unter einem Doppelklick, falls es zu einem Bild-Block gehört. */
export function imageAt(target: EventTarget | null): ImageView | undefined {
  const el = target instanceof Element ? target : undefined;
  const img = el?.closest("img");
  if (!img || !img.closest('[data-content-type="image"], .bx2-image')) return undefined;
  const src = img.currentSrc || img.src;
  return src ? { src, alt: img.alt || "" } : undefined;
}

export function ImageViewer({ view, onClose }: { view: ImageView; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      before?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="bx-image-viewer" role="dialog" aria-modal="true" aria-label="Image" data-testid="image-viewer" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <img src={view.src} alt={view.alt} />
      <button ref={close} type="button" className="bx-image-viewer-close" aria-label="Close" onClick={onClose}>×</button>
    </div>
  );
}
