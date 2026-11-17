// Ergebnis eines HTML-Codeblocks: abgeschotteter Rahmen ohne Netz, der sich wie ein Stück der Seite verhält –
// Schrift, Textfarbe und hell/dunkel von der Seite, durchsichtiger Grund, Höhe nach dem Inhalt (wie Notions HTML-Block).
/** Kein Netz, keine Formulare nach außen; Skripte nur im abgeschotteten Rahmen. */
export const HTML_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** Was der Rahmen von der Seite übernimmt (berechnete Werte, der Rahmen sieht die Tokens nicht). */
export interface HtmlPreviewTheme {
  scheme: "light" | "dark";
  color: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
}

/** Schlüssel der Höhenmeldung aus dem Rahmen (postMessage; der Rahmen hat eine eigene, undurchsichtige Origin). */
export const HTML_PREVIEW_HEIGHT_KEY = "basedHtmlHeight";
/** Grenzen der Höhe nach Inhalt in CSS-Pixeln; darüber rollt der Rahmen selbst. */
export const HTML_PREVIEW_HEIGHT = { min: 24, max: 1200 } as const;

export function hostScheme(doc: Document = document): "light" | "dark" {
  const set = doc.documentElement.dataset.theme;
  if (set === "dark" || set === "light") return set;
  return doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Schrift und Farbe an der Stelle, an der das Ergebnis steht. */
export function htmlThemeAt(el: HTMLElement): HtmlPreviewTheme {
  const css = getComputedStyle(el);
  return { scheme: hostScheme(el.ownerDocument), color: css.color, fontFamily: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight };
}

// Werte kommen aus berechnetem CSS; trotzdem nichts durchlassen, was aus dem <style> ausbrechen könnte.
const cssValue = (v: string) => v.replace(/[<>{};]/g, "");

function baseStyle(t: HtmlPreviewTheme): string {
  return `<style>:root{color-scheme:${t.scheme}}html,body{background:transparent}` +
    `body{margin:0;color:${cssValue(t.color)};font-family:${cssValue(t.fontFamily)};font-size:${cssValue(t.fontSize)};line-height:${cssValue(t.lineHeight)}}</style>`;
}

// Meldet die Höhe des Inhalts an die Seite: Körperhöhe samt Außenabstand (nicht die des Fensters, sonst schrumpft nichts).
const HEIGHT_SCRIPT = `<script>(()=>{let last=-1;const post=()=>{const b=document.body;if(!b)return;const s=getComputedStyle(b);` +
  `const h=Math.ceil(Math.max(b.scrollHeight,b.offsetHeight)+(parseFloat(s.marginTop)||0)+(parseFloat(s.marginBottom)||0));` +
  `if(h===last)return;last=h;parent.postMessage({${HTML_PREVIEW_HEIGHT_KEY}:h},"*")};` +
  `addEventListener("DOMContentLoaded",()=>{post();new ResizeObserver(post).observe(document.body);` +
  `new MutationObserver(post).observe(document.body,{childList:true,subtree:true,attributes:true,characterData:true})});` +
  `addEventListener("load",post)})()</script>`;

/** Inhalt des Rahmens: CSP vorneweg, Grundstil der Seite, Höhenmeldung, dann der Code (der alles überschreiben darf). */
export function htmlPreviewDoc(code: string, theme?: HtmlPreviewTheme): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">` +
    (theme ? baseStyle(theme) : "") + HEIGHT_SCRIPT + code;
}

/** Höhe aus einer Meldung des Rahmens, begrenzt; `undefined`, wenn die Nachricht keine ist. */
export function htmlPreviewHeight(data: unknown): number | undefined {
  const h = typeof data === "object" && data !== null ? (data as Record<string, unknown>)[HTML_PREVIEW_HEIGHT_KEY] : undefined;
  if (typeof h !== "number" || !Number.isFinite(h)) return undefined;
  return Math.min(Math.max(Math.round(h), HTML_PREVIEW_HEIGHT.min), HTML_PREVIEW_HEIGHT.max);
}
