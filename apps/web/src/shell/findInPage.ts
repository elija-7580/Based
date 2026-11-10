// BSD-206: Suchen in der Seite (⌘F). Die Fundstellen rechnet @based/core (findInText); hier nur der DOM-Teil: Text der
// Seite blockweise einsammeln, Fundstellen als Range, Anzeige über die CSS Custom Highlight API – der Editor-DOM bleibt
// unberührt (kein <mark> im ProseMirror-Baum).
import { findInText } from "@based/core";

const BLOCK = ".bn-block-content, td, th, li, p, h1, h2, h3, h4, pre, blockquote, [role=gridcell], [role=cell], [data-find-block]";
const SKIP = "[aria-hidden=true], [data-find-skip], script, style, .find-bar, button[aria-haspopup]";
export const MAX_MATCHES = 2000;

function visible(el: Element): boolean {
  const h = el as HTMLElement;
  return h.offsetParent !== null || h.getClientRects().length > 0;
}

/** Fundstellen von `query` unter `root`, in Dokumentreihenfolge. Treffer dürfen über Formatierungsgrenzen gehen (ein Block = ein Text). */
export function findRanges(root: Element, query: string, limit = MAX_MATCHES): Range[] {
  if (!query) return [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p || !n.nodeValue || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Range[] = [];
  let group: Text[] = [], groupBlock: Element | null = null;
  const flush = () => {
    const nodes = group;
    group = [];
    if (nodes.length === 0 || out.length >= limit) return;
    if (groupBlock && !visible(groupBlock)) return;
    const text = nodes.map((n) => n.data).join("");
    const hits = findInText(text, query, limit - out.length);
    if (hits.length === 0) return;
    // Stelle im Blocktext → (Textknoten, Offset)
    const locate = (at: number, end: boolean): [Text, number] => {
      let acc = 0;
      for (const n of nodes) {
        const len = n.data.length;
        if (at < acc + len || (end && at === acc + len)) return [n, at - acc];
        acc += len;
      }
      const last = nodes[nodes.length - 1]!;
      return [last, last.data.length];
    };
    for (const h of hits) {
      const r = doc.createRange();
      const [sn, so] = locate(h.start, false), [en, eo] = locate(h.end, true);
      r.setStart(sn, so);
      r.setEnd(en, eo);
      out.push(r);
    }
  };
  for (let n = walker.nextNode() as Text | null; n && out.length < limit; n = walker.nextNode() as Text | null) {
    const block = n.parentElement!.closest(BLOCK) ?? n.parentElement!;
    if (block !== groupBlock) {
      flush();
      groupBlock = block;
    }
    group.push(n);
  }
  flush();
  return out;
}

interface HighlightRegistry { set(name: string, h: unknown): void; delete(name: string): void }
const registry = (): HighlightRegistry | undefined => (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
const HighlightCtor = (): (new (...r: Range[]) => unknown) | undefined => (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

/** Fundstellen einfärben (`::highlight(based-find)`, aktuelle: `based-find-current`). Ohne Highlight-API: nur zählen und springen. */
export function paintMatches(ranges: Range[], current: number) {
  const reg = registry(), H = HighlightCtor();
  if (!reg || !H) return;
  if (ranges.length === 0) return clearMatches();
  reg.set("based-find", new H(...ranges));
  const cur = ranges[current];
  if (cur) reg.set("based-find-current", new H(cur));
  else reg.delete("based-find-current");
}

export function clearMatches() {
  const reg = registry();
  reg?.delete("based-find");
  reg?.delete("based-find-current");
}

/** Aktuelle Fundstelle in den sichtbaren Bereich holen (nur wenn sie außerhalb liegt). */
export function revealRange(r: Range, scroller: Element | null) {
  const rect = r.getBoundingClientRect();
  const box = scroller?.getBoundingClientRect() ?? { top: 0, bottom: globalThis.innerHeight };
  const margin = 96;
  if (rect.top >= box.top + margin && rect.bottom <= box.bottom - margin) return;
  const el = r.startContainer.parentElement;
  el?.scrollIntoView({ block: "center", inline: "nearest" });
}

/** Index der ersten Fundstelle ab der Bildschirmmitte abwärts – ⌘F springt nicht an den Seitenanfang. */
export function firstVisibleIndex(ranges: Range[], scroller: Element | null): number {
  const top = scroller?.getBoundingClientRect().top ?? 0;
  for (let i = 0; i < ranges.length; i++) if (ranges[i]!.getBoundingClientRect().bottom >= top) return i;
  return 0;
}
