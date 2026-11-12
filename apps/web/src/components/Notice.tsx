// BSD-163: Hinweise aus dem Worker (z. B. „bleibt: der Agent Brain ist geschützt“). Verschwindet nach 8 s oder per
// „Dismiss“; ein neuer Hinweis ersetzt den alten.
import { useEffect } from "react";
import "./notice.css";

export function Notice({ notice, onDismiss }: { notice: { id: number; message: string } | undefined; onDismiss: () => void }) {
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(onDismiss, 8000);
    return () => clearTimeout(t);
  }, [notice, onDismiss]);
  if (!notice) return null;
  return (
    <div key={notice.id} className="app-notice" role="status" aria-live="polite" data-testid="app-notice">
      <span>{notice.message}</span>
      <button type="button" className="btn ghost" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}
