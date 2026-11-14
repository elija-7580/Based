// BSD-238: Mit F6 / ⇧F6 zwischen den Bereichen springen (Seitenleiste → Kopfzeile → Seite), wie in Browsern und
// Desktop-Apps üblich. Jeder Bereich hat ein bevorzugtes Ziel (aktiver Seitenbaum-Eintrag, Editor) und sonst das
// erste fokussierbare Element.

export const REGIONS = [
  { id: "sidebar", root: "nav.sidebar", prefer: ["[role=treeitem][aria-selected=true]", "[role=treeitem]"] },
  { id: "header", root: ".panel .topbar", prefer: [] },
  // BSD-407 Teil 3: im Block-Editor das erste Textfeld, im alten Editor das Dokument
  { id: "page", root: ".panel", prefer: ["[data-testid=block-editor] [data-editable-id][contenteditable=true]", ".bn-editor[contenteditable=true]", "[role=grid]"], skip: ".topbar" },
] as const;

export type RegionID = (typeof REGIONS)[number]["id"];

const FOCUSABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1']), [contenteditable=true]";

/** Nächster Bereich in Richtung `dir` ab `current` (unbekannt: von vorn bzw. hinten); `available` filtert leere. */
export function nextRegion(current: RegionID | undefined, dir: 1 | -1, available: readonly RegionID[]): RegionID | undefined {
  const ids = REGIONS.map((r) => r.id).filter((id) => available.includes(id));
  if (!ids.length) return undefined;
  const at = current ? ids.indexOf(current) : -1;
  if (at < 0) return dir > 0 ? ids[0] : ids[ids.length - 1];
  return ids[(at + dir + ids.length) % ids.length];
}

function visible(el: Element): boolean {
  return !(el as HTMLElement).hidden && (el as HTMLElement).getClientRects().length > 0;
}

function target(doc: Document, id: RegionID): HTMLElement | undefined {
  const r = REGIONS.find((x) => x.id === id)!;
  const root = doc.querySelector<HTMLElement>(r.root);
  if (!root || !visible(root)) return undefined;
  const skip = "skip" in r ? root.querySelector(r.skip) : null;
  for (const sel of r.prefer) {
    const hit = [...root.querySelectorAll<HTMLElement>(sel)].find((el) => visible(el) && !skip?.contains(el));
    if (hit) return hit;
  }
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => visible(el) && !skip?.contains(el));
}

function currentRegion(doc: Document): RegionID | undefined {
  const a = doc.activeElement;
  if (!a || a === doc.body) return undefined;
  if (a.closest("nav.sidebar")) return "sidebar";
  if (a.closest(".topbar")) return "header";
  if (a.closest(".panel")) return "page";
  return undefined;
}

/** F6/⇧F6: Fokus in den nächsten Bereich. Liefert, wohin (oder `undefined`, wenn es keinen gibt). */
export function cycleRegion(doc: Document, dir: 1 | -1): RegionID | undefined {
  const available = REGIONS.map((r) => r.id).filter((id) => target(doc, id));
  const next = nextRegion(currentRegion(doc), dir, available);
  if (next) target(doc, next)?.focus();
  return next;
}
