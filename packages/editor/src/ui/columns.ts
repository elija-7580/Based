// BSD-210: Spaltenbreiten wie in Notion/Swift – je Spalte ein Anteil an der Zeile (`ratio`, Summe 1). Fehlende
// Anteile (0) teilen sich den Rest gleichmäßig. Reine Funktionen, die Ansicht (schema/blocks.tsx) zieht nur.

/** Kleinster Anteil einer Spalte beim Ziehen. */
export const MIN_COLUMN = 0.1;

/** Anteile auf Summe 1 bringen; Spalten ohne Anteil bekommen gleich viel vom Rest (bzw. 1/n). */
export function columnFractions(widths: readonly number[]): number[] {
  const n = widths.length;
  if (n === 0) return [];
  const set = widths.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const known = set.reduce((a, b) => a + b, 0);
  const missing = set.filter((w) => w === 0).length;
  let fill = missing ? Math.max(1 - known, 0) / missing : 0;
  if (missing && fill <= 0) fill = 1 / n;
  const raw = set.map((w) => (w === 0 ? fill : w));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

/**
 * Grenze zwischen Spalte `i-1` und `i` um `delta` (Anteil der Zeile, + = nach rechts) verschieben. Nur die beiden
 * Nachbarn ändern sich, keiner wird schmaler als `min`. Gerundet auf drei Stellen (wie Swift-Fixtures).
 */
export function resizeColumns(fractions: readonly number[], i: number, delta: number, min = MIN_COLUMN): number[] {
  if (i <= 0 || i >= fractions.length) return [...fractions];
  const a = fractions[i - 1]!, b = fractions[i]!;
  const d = Math.min(Math.max(delta, min - a), b - min);
  const out = [...fractions];
  out[i - 1] = a + d;
  out[i] = b - d;
  return out.map((f) => Math.round(f * 1000) / 1000);
}
