// Fokus mit den Pfeiltasten: von einem Bedienelement zum nächstgelegenen in Pfeilrichtung (wie auf dem Fernseher
// oder in Spielemenüs). Rein, nur Rechtecke – die DOM-Seite steht in apps/web/src/shell/arrowNav.ts.

export interface Box { left: number; top: number; right: number; bottom: number }
export type Direction = "up" | "down" | "left" | "right";

const mid = (a: number, b: number) => (a + b) / 2;

/**
 * Index des besten Ziels in `candidates` oder -1. Ein Ziel muss in Pfeilrichtung liegen (seine Mitte hinter der
 * eigenen Kante). Bewertet wird der Abstand in Pfeilrichtung plus der seitliche Versatz (doppelt gewichtet);
 * Ziele, die sich quer zur Richtung mit dem Ausgang überlappen (gleiche Zeile bzw. Spalte), gewinnen immer.
 */
export function nextInDirection(from: Box, candidates: readonly Box[], dir: Direction): number {
  const horizontal = dir === "left" || dir === "right";
  const sign = dir === "right" || dir === "down" ? 1 : -1;
  let best = -1, bestScore = Infinity;
  candidates.forEach((c, i) => {
    const fromEdge = horizontal ? (sign > 0 ? from.right : from.left) : (sign > 0 ? from.bottom : from.top);
    const center = horizontal ? mid(c.left, c.right) : mid(c.top, c.bottom);
    // eine halbe Einheit Spielraum: bündig anschließende Elemente zählen
    if (sign * (center - fromEdge) <= -0.5) return;
    const nearEdge = horizontal ? (sign > 0 ? c.left : c.right) : (sign > 0 ? c.top : c.bottom);
    const along = Math.max(0, sign * (nearEdge - fromEdge));
    const [a0, a1, b0, b1] = horizontal ? [from.top, from.bottom, c.top, c.bottom] : [from.left, from.right, c.left, c.right];
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    const across = overlap > 0 ? 0 : Math.abs(mid(a0, a1) - mid(b0, b1));
    const score = along + across * 2 + (overlap > 0 ? 0 : 10_000);
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}
