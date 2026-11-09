// Fenster-Rechnung für virtualisierte Listen mit fester Zeilenhöhe: welche Zeilen sind sichtbar (plus Vorrat)?
// Rein und ohne DOM, damit sie in Node getestet werden kann.

export interface WindowRange {
  /** Erste gerenderte Zeile (inklusive). */
  start: number;
  /** Letzte gerenderte Zeile (exklusive). */
  end: number;
}

/**
 * Gerenderte Zeilen für eine Scrollposition. `overscan` Zeilen über und unter dem sichtbaren Bereich, damit schnelles
 * Scrollen keine leeren Streifen zeigt. Die Anzahl ist durch (Sichthöhe / Zeilenhöhe + 2·overscan + 1) begrenzt –
 * unabhängig von der Länge der Liste.
 */
export function windowRange(count: number, rowHeight: number, scrollTop: number, viewport: number, overscan = 8): WindowRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewport) / rowHeight) + 1;
  const start = Math.max(0, Math.min(count - 1, first) - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end: Math.max(start, end) };
}

/** Scrollposition, damit Zeile `index` ganz sichtbar ist (unverändert, wenn sie es schon ist). */
export function scrollToReveal(index: number, rowHeight: number, scrollTop: number, viewport: number): number {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return top + rowHeight - viewport;
  return scrollTop;
}

export const sameRange = (a: WindowRange, b: WindowRange) => a.start === b.start && a.end === b.end;
