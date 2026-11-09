// Der Agent-Marker (ADR 0012): ein Signal mit genau einer Bedeutung – „ein Agent hat das geschrieben oder geändert“.
// Nie für Buttons, Überschriften, Fehler oder Menschenarbeit. Trägt Bedeutung nie allein: Tag und Label sagen es.
import type { ReactNode } from "react";

/** Block, den ein Agent schrieb: 3-px-Strich im Rand, Tag „Based“ mit Herkunft in der Randspalte (`origin`). */
export function AgentBlock({ children }: { children: ReactNode }) {
  return (
    <div className="agent-block" aria-label="Written by Based">
      {children}
    </div>
  );
}

/** Tag in der Randspalte: „Based“ + Herkunft. */
export function AgentTag({ origin }: { origin?: string }) {
  return (
    <div className="margin-note t-meta">
      <span className="agent-tag">Based</span>
      {origin ? (
        <>
          <br />
          {origin}
        </>
      ) : null}
    </div>
  );
}

/** Textstelle im eigenen Text, die ein Agent geändert hat. */
export function AgentInline({ children }: { children: ReactNode }) {
  return (
    <mark className="agent-inline" title="Changed by Based">
      {children}
      <span className="sr-only"> (changed by Based)</span>
    </mark>
  );
}

/** Strich am linken Rand (Zeile, Karte, Nachricht); `on=false` hält den Platz frei. */
export function AgentBar({ on = true, label = "Changed by Based" }: { on?: boolean; label?: string }) {
  return on ? <span className="agent-bar" role="img" aria-label={label} /> : <span className="agent-bar off" aria-hidden="true" />;
}
