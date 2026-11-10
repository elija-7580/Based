/**
 * Graphem-Cluster (Swift `Character`s) – robust gegen große Texte.
 *
 * `Intl.Segmenter` klont pro `segment()` einen ICU-Break-Iterator. In WKWebView (System-ICU am Mac) schlägt das
 * bei großen Importen fehl („failed to initialize SegmentIterator“) und brach den ganzen Import ab. Deshalb:
 * 1. Schneller Weg ohne ICU für Text, in dem jede UTF-16-Einheit ein eigenes Graphem ist (kein CR, nichts ab
 *    U+0300 – dort beginnen kombinierende Zeichen, Hangul, Emoji usw.). Das ist der Großteil von Import-Text.
 * 2. Lange Texte werden an Zeilenumbrüchen (immer eine Graphem-Grenze, außer zwischen CR und LF) in Abschnitte
 *    zerlegt, damit ICU nie einen riesigen Text auf einmal bekommt.
 * 3. Wirft ICU trotzdem, gibt es eine Näherung per Regex statt eines Abbruchs.
 */

let segmenter: Intl.Segmenter | undefined;
const seg = () => (segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" }));

/** Abschnittsgröße für ICU (UTF-16-Einheiten). */
export const GRAPHEME_CHUNK = 64 * 1024;

// eslint-disable-next-line no-control-regex
const SIMPLE = /^[\u0000-\u000c\u000e-˿]*$/;

/** Näherung der erweiterten Graphem-Cluster (UAX #29) für den Notfall. */
const FALLBACK =
  /\r\n|\p{RI}\p{RI}|(?:\p{Extended_Pictographic}[\p{M}\p{EMod}️]*(?:‍\p{Extended_Pictographic}[\p{M}\p{EMod}️]*)*)|[ᄀ-ᅟ]+[ᅠ-ᆧ]*[ᆨ-ᇿ]*|[^]\p{M}*/gu;

const fallback = (s: string): string[] => s.match(FALLBACK) ?? [];

function segmentChunk(s: string, out: string[]): void {
  try {
    for (const x of seg().segment(s)) out.push(x.segment);
  } catch {
    for (const g of fallback(s)) out.push(g);
  }
}

export function graphemes(s: string): string[] {
  if (s.length === 0) return [];
  if (SIMPLE.test(s)) return s.split("");
  const out: string[] = [];
  if (s.length <= GRAPHEME_CHUNK) {
    segmentChunk(s, out);
    return out;
  }
  let start = 0;
  while (start < s.length) {
    let end = Math.min(s.length, start + GRAPHEME_CHUNK);
    if (end < s.length) {
      // Bis zum nächsten LF erweitern (Grenze nach LF ist immer sicher; CR LF bleibt zusammen).
      const nl = s.indexOf("\n", end);
      end = nl === -1 ? s.length : nl + 1;
    }
    segmentChunk(s.slice(start, end), out);
    start = end;
  }
  return out;
}

/** Erstes Graphem, ohne den ganzen Text zu zerlegen. */
export function firstGrapheme(s: string): string | undefined {
  if (s.length === 0) return undefined;
  return graphemes(s.slice(0, 256))[0];
}

/** Anzahl der Grapheme. */
export const graphemeCount = (s: string): number => (SIMPLE.test(s) ? s.length : graphemes(s).length);
