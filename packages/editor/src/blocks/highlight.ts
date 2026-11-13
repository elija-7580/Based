// ADR 0016 (E6): Syntax-Hervorhebung im Code-Block des neuen Editors – über die CSS Custom Highlight API, damit das
// DOM des Textfelds unverändert bleibt (es wird nur aus dem Modell geschrieben). Tokens wie der alte Editor
// (`syntaxTokens` aus @based/core, Swift-Hervorheber). Ohne Highlight API: kein Hervorheben.
import { syntaxTokens, type SyntaxKind } from "@based/core";
import { pointAt } from "./dom.js";

const KINDS: readonly SyntaxKind[] = ["keyword", "string", "comment", "number", "type", "function", "property"];
const perBlock = new Map<string, Map<SyntaxKind, Range[]>>();

type HighlightCtor = new (...ranges: Range[]) => unknown;
interface Registry { set(name: string, h: unknown): void; delete(name: string): void }

function registry(): { reg: Registry; H: HighlightCtor } | undefined {
  const css = (globalThis as { CSS?: { highlights?: Registry } }).CSS;
  const H = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return css?.highlights && H ? { reg: css.highlights, H } : undefined;
}

/** Hervorhebung eines Code-Felds setzen (`el = null`: entfernen). */
export function highlightCode(blockID: string, el: HTMLElement | null, code: string, language: string | undefined): void {
  const r = registry();
  if (!r) return;
  if (!el || !code) perBlock.delete(blockID);
  else {
    const byKind = new Map<SyntaxKind, Range[]>();
    const doc = el.ownerDocument;
    for (const t of syntaxTokens(code, language)) {
      const a = pointAt(el, t.from), b = pointAt(el, t.from + t.length);
      const range = doc.createRange();
      try {
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
      } catch {
        continue;
      }
      let list = byKind.get(t.kind);
      if (!list) byKind.set(t.kind, (list = []));
      list.push(range);
    }
    perBlock.set(blockID, byKind);
  }
  for (const kind of KINDS) {
    const all = [...perBlock.values()].flatMap((m) => m.get(kind) ?? []);
    if (all.length) r.reg.set("bx2-syn-" + kind, new r.H(...all));
    else r.reg.delete("bx2-syn-" + kind);
  }
}
