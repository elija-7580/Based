// BSD-238: Pfeiltasten zwischen Karten (Board, Galerie) und Listenzeilen – die nächste Karte in einer Richtung, rein
// geometrisch aus den gezeichneten Rechtecken (passt für Spalten, Raster und Listen; getestet in logic.test.ts).

export interface Box { left: number; top: number; right: number; bottom: number }
export type Direction = "up" | "down" | "left" | "right";

export const directionOf = (key: string): Direction | undefined =>
  key === "ArrowUp" ? "up" : key === "ArrowDown" ? "down" : key === "ArrowLeft" ? "left" : key === "ArrowRight" ? "right" : undefined;

/** Abstand zweier Intervalle (0 bei Überlappung). */
const gap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.max(a0, b0) - Math.min(a1, b1));

/**
 * Index des Nachbarn von `from` in Richtung `dir`, oder -1. Bevorzugt Karten in derselben Spalte/Zeile (Überlappung quer
 * zur Richtung), dann die nächste; quer versetzte Karten zählen dreifach, damit ↓ in der Spalte bleibt.
 */
export function nearestInDirection(from: Box, boxes: readonly Box[], dir: Direction): number {
  const vertical = dir === "up" || dir === "down";
  const cx = (from.left + from.right) / 2, cy = (from.top + from.bottom) / 2;
  let best = -1, bestScore = Infinity;
  boxes.forEach((b, i) => {
    const bx = (b.left + b.right) / 2, by = (b.top + b.bottom) / 2;
    const ahead = dir === "down" ? by - cy : dir === "up" ? cy - by : dir === "right" ? bx - cx : cx - bx;
    if (ahead <= 1) return;
    const across = vertical ? gap(from.left, from.right, b.left, b.right) : gap(from.top, from.bottom, b.top, b.bottom);
    // Waagrecht in die Nachbarspalte: dort die Karte auf gleicher Höhe (Mitte), nicht die erste.
    const drift = across > 0 ? across : vertical ? 0 : Math.abs(by - cy) / 4;
    const score = ahead + drift * 3 + (across > 0 ? 10_000 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best < 0) return -1;
  // Nur wenn nichts überlappt, darf ein versetzter Nachbar gewinnen – aber nie für ↑/↓ über Spalten hinweg.
  return bestScore >= 10_000 && vertical ? -1 : best;
}
