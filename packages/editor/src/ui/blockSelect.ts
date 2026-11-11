// BSD-258: Blöcke mit der Maus auswählen wie in Notion – Rechteck (Marquee) aus dem Seitenrand, Textauswahl über
// Nicht-Text-Blöcke wird zur Blockauswahl, ⇧-Klick erweitert, ⌘A zweimal wählt alle Blöcke. Die Auswahl selbst ist die
// Esc-Blockauswahl aus BSD-207 (Spanne von Geschwistern, `BlockRange`).
import type { BlockRange } from "./blockActions.js";
import type { Rect } from "./dragDrop.js";

/** Kleinste Rechteck-Größe, bevor ein Ziehen im Rand als Auswahl zählt (sonst ist es ein Klick). */
export const MARQUEE_MIN = 4;

export const rectFrom = (a: { x: number; y: number }, b: { x: number; y: number }): Rect =>
  ({ left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) });

/**
 * Welche Blöcke ein Rechteck trifft: nur die Höhe zählt (wie Notion – das Rechteck beginnt im Rand neben dem Text).
 * `blocks` in Dokument-Reihenfolge; liefert die Spanne vom ersten bis zum letzten getroffenen.
 */
export function marqueeRange(rect: Rect, blocks: readonly { id: string; top: number; bottom: number }[]): BlockRange | undefined {
  const hit = blocks.filter((b) => b.bottom > rect.top && b.top < rect.bottom);
  if (hit.length === 0) return undefined;
  return { anchor: hit[0]!.id, head: hit[hit.length - 1]!.id };
}

/** Text-Blöcke (Absatz, Überschrift, Listen …) lassen sich mit Text auswählen; Bilder, Datenbanken, Embeds nicht. */
export const hasText = (b: { content?: unknown }) => Array.isArray(b.content);

/** Kette der Vorfahren (innen nach außen) eines Blocks, ohne ihn selbst. */
type ParentOf = (id: string) => { id: string } | undefined;
function ancestors(parentOf: ParentOf, id: string): string[] {
  const out: string[] = [];
  for (let p = parentOf(id); p && out.length < 64; p = parentOf(p.id)) out.push(p.id);
  return out;
}

/**
 * Zwei Blöcke auf dieselbe Ebene bringen (für eine Spanne): die Vorfahren, die unter dem gemeinsamen Elternteil
 * stehen. Liegen sie schon nebeneinander, bleiben sie.
 */
export function siblingSpan(parentOf: ParentOf, a: string, b: string): BlockRange {
  const pa = [a, ...ancestors(parentOf, a)];
  const pb = [b, ...ancestors(parentOf, b)];
  const setB = new Set(pb);
  // Erster gemeinsamer Vorfahr (oder die Wurzel, wenn keiner)
  const common = pa.find((x, i) => i > 0 && setB.has(x));
  const below = (chain: string[]) => {
    if (common === undefined) return chain[chain.length - 1]!;
    const i = chain.indexOf(common);
    return chain[i - 1] ?? chain[0]!;
  };
  if (pa.includes(b)) return { anchor: b, head: b };
  if (pb.includes(a)) return { anchor: a, head: a };
  return { anchor: below(pa), head: below(pb) };
}
