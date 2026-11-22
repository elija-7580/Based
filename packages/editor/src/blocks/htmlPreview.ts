// Ergebnis eines HTML-Codeblocks: abgeschotteter Rahmen ohne Netz auf einer Based-Fläche (Karte im Editor).
// Der Rahmen bekommt die Based-Tokens als CSS-Variablen und einen Grundstil in Based-Optik (Schrift, Überschriften,
// Links, Tabellen, Buttons, Felder, Code). Alle Regeln stehen in :where() – eigenes CSS der Datei gewinnt immer.
/** Kein Netz, keine Formulare nach außen; Skripte nur im abgeschotteten Rahmen. */
export const HTML_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** Tokens, die der Rahmen als `var(--…)` kennt (er sieht die Tokens der Seite sonst nicht). */
export const HTML_PREVIEW_TOKENS = [
  "--bg", "--ink", "--ink-2", "--muted", "--line", "--surface-soft", "--surface-raised", "--surface-card", "--selected",
  "--selection-bg", "--focus-ring", "--button", "--button-ink", "--danger", "--shadow-control",
  "--radius-xs", "--radius-sm", "--radius-md", "--radius-pill", "--control-md",
  "--space-half", "--space-1", "--space-2", "--space-3", "--space-4", "--space-5", "--space-7",
  "--font-ui", "--font-mono", "--type-ui-size", "--type-code-size", "--type-label-weight",
] as const;

/** Was der Rahmen von der Seite übernimmt (berechnete Werte). */
export interface HtmlPreviewTheme {
  scheme: "light" | "dark";
  color: string;
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  tokens?: Record<string, string>;
  /** Fertige `@font-face`-Regeln mit eingebetteten Dateien (siehe `hostFontFaces`). */
  fontFaces?: string;
}

/** Schlüssel der Höhenmeldung aus dem Rahmen (postMessage; der Rahmen hat eine eigene, undurchsichtige Origin). */
export const HTML_PREVIEW_HEIGHT_KEY = "basedHtmlHeight";
/** Grenzen der Höhe nach Inhalt in CSS-Pixeln; darüber rollt der Rahmen selbst. */
export const HTML_PREVIEW_HEIGHT = { min: 24, max: 1200 } as const;
/** Anfangshöhe einer ganzen HTML-Datei: Seiten mit `height: 100vh` behalten sie (sie wachsen sonst endlos mit). */
export const HTML_DOCUMENT_HEIGHT = 420;

/** Ganze Datei (eigenes <html>/<body>, z. B. ein exportiertes Artefakt) statt eines Schnipsels? */
export function isHtmlDocument(code: string): boolean {
  return /<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i.test(code.slice(0, 4000));
}

export function hostScheme(doc: Document = document): "light" | "dark" {
  const set = doc.documentElement.dataset.theme;
  if (set === "dark" || set === "light") return set;
  return doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Schrift, Farbe und Tokens an der Stelle, an der das Ergebnis steht. */
export function htmlThemeAt(el: HTMLElement): HtmlPreviewTheme {
  const css = getComputedStyle(el);
  const tokens: Record<string, string> = {};
  for (const t of HTML_PREVIEW_TOKENS) {
    const v = css.getPropertyValue(t).trim();
    if (v) tokens[t] = v;
  }
  return { scheme: hostScheme(el.ownerDocument), color: css.color, fontFamily: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight, tokens };
}

// MARK: Schriften der Seite im Rahmen
// Der Rahmen hat kein Netz und eine eigene Origin: Webschriften der Seite (Font „Based“: Schibsted Grotesk, Literata)
// kennt er nicht, Text fiel auf Georgia und die Systemschrift zurück. Deshalb bekommt er die Schriften, die die Seite
// an dieser Stelle benutzt und schon geladen hat, als eingebettete `data:`-Dateien mit (die CSP erlaubt nur die).

const familyNames = (list: string) => list.split(",").map((f) => f.trim().replace(/^["']|["']$/g, "").toLowerCase()).filter(Boolean);
const rangeKey = (r: string) => r.toLowerCase().replace(/\s+/g, "").replace(/u\+0+(?=[0-9a-f?])/g, "u+").replace(/-0+(?=[0-9a-f])/g, "-");
const faceKey = (family: string, style: string, range: string) => `${familyNames(family)[0] ?? ""}|${style.trim() || "normal"}|${rangeKey(range || "U+0-10FFFF")}`;

const fontData = new Map<string, Promise<string | undefined>>();
function fontDataUrl(url: string): Promise<string | undefined> {
  let p = fontData.get(url);
  if (!p) {
    p = fetch(url).then(async (r) => {
      if (!r.ok) return undefined;
      const bytes = new Uint8Array(await r.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return `data:font/woff2;base64,${btoa(bin)}`;
    }).catch(() => undefined);
    fontData.set(url, p);
  }
  return p;
}

/** `@font-face`-Regeln (mit eingebetteten Dateien) für die Webschriften, die `theme` nennt und die Seite geladen hat. */
export async function hostFontFaces(doc: Document, theme: HtmlPreviewTheme): Promise<string> {
  try {
    const wanted = new Set(familyNames([theme.fontFamily, theme.tokens?.["--font-ui"] ?? ""].join(",")));
    const loaded = new Set<string>();
    doc.fonts?.forEach((f) => { if (f.status === "loaded") loaded.add(faceKey(f.family, f.style, f.unicodeRange)); });
    if (!loaded.size) return "";
    const jobs: Promise<string>[] = [];
    for (const sheet of Array.from(doc.styleSheets)) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules)) {
        if (rule.constructor.name !== "CSSFontFaceRule") continue;
        const st = (rule as CSSFontFaceRule).style;
        const family = familyNames(st.getPropertyValue("font-family"))[0];
        const style = st.getPropertyValue("font-style").trim() || "normal";
        const range = st.getPropertyValue("unicode-range");
        if (!family || !wanted.has(family) || !loaded.has(faceKey(family, style, range))) continue;
        const src = /url\(\s*["']?([^"')]+\.woff2[^"')]*)["']?\s*\)/.exec(st.getPropertyValue("src"))?.[1];
        if (!src) continue;
        const weight = st.getPropertyValue("font-weight").trim() || "400";
        jobs.push(fontDataUrl(new URL(src, sheet.href ?? doc.baseURI).href).then((data) => data
          ? `@font-face{font-family:"${cssValue(family).replace(/"/g, "")}";font-style:${cssValue(style)};font-weight:${cssValue(weight)};font-display:block;src:url(${data}) format("woff2")${range ? `;unicode-range:${cssValue(range)}` : ""}}`
          : ""));
      }
    }
    return (await Promise.all(jobs)).join("");
  } catch {
    return "";
  }
}

// Werte kommen aus berechnetem CSS; trotzdem nichts durchlassen, was aus dem <style> ausbrechen könnte.
const cssValue = (v: string) => v.replace(/[<>{};]/g, "");

/** Grundstil in Based-Optik. Nur :where() (Spezifität 0), damit jedes eigene CSS der Datei gewinnt. */
const BASED_BASE = [
  ":where(html){-webkit-text-size-adjust:100%}",
  // Rollbalken wie in der App (BSD-261): WebKit und Chromium zeichnen mit scrollbar-width/-color den Systembalken mit
  // heller Spur (am Mac ein weißer Streifen am Rand der Karte) – die Standard-Eigenschaften deshalb nur für Firefox.
  "@supports not selector(::-webkit-scrollbar){:where(html){scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--ink) 22%,transparent) transparent}}",
  "::-webkit-scrollbar{width:var(--space-2);height:var(--space-2);background:transparent}",
  "::-webkit-scrollbar-track,::-webkit-scrollbar-corner,::-webkit-scrollbar-track-piece{background:transparent;border:0}",
  "::-webkit-scrollbar-button{display:none;width:0;height:0}",
  "::-webkit-scrollbar-thumb{background-color:color-mix(in srgb,var(--ink) 22%,transparent);border-radius:var(--radius-pill);border:var(--space-half) solid transparent;background-clip:padding-box;min-height:var(--space-7);min-width:var(--space-7)}",
  "::-webkit-scrollbar-thumb:hover,::-webkit-scrollbar-thumb:active{background-color:color-mix(in srgb,var(--ink) 40%,transparent)}",
  ":where(html,body){background:transparent}",
  // flow-root: Außenabstände der ersten/letzten Kinder fallen nicht aus dem body heraus (sonst stimmt die Höhe nicht)
  ":where(body){margin:0;display:flow-root;overflow-wrap:anywhere}",
  "::selection{background:var(--selection-bg)}",
  ":where(h1,h2,h3,h4,h5,h6){font-family:var(--font-ui);font-weight:600;line-height:1.3;margin:1em 0 .35em}",
  ":where(h1){font-size:1.6em}:where(h2){font-size:1.35em}:where(h3){font-size:1.15em}:where(h4,h5,h6){font-size:1em}",
  ":where(p,ul,ol,blockquote,figure){margin:.5em 0}",
  ":where(body>:first-child){margin-top:0}:where(body>:last-child){margin-bottom:0}",
  ":where(a){color:inherit;text-decoration:underline;text-decoration-color:var(--muted);text-underline-offset:3px}",
  ":where(small,figcaption,caption){color:var(--muted)}",
  ":where(blockquote){padding-left:var(--space-3);border-left:3px solid var(--ink)}",
  ":where(hr){border:0;border-top:1px solid var(--line);margin:var(--space-4) 0}",
  ":where(code,kbd,samp,pre){font-family:var(--font-mono);font-size:.9em}",
  ":where(code,kbd){padding:.1em .35em;border-radius:var(--radius-xs);background:var(--selected)}",
  ":where(pre){padding:var(--space-3);border-radius:var(--radius-sm);background:var(--selected);overflow:auto}",
  ":where(pre code){padding:0;background:none}",
  ":where(img,video){max-width:100%;height:auto;border-radius:var(--radius-sm)}",
  ":where(table){border-collapse:collapse;width:100%;margin:var(--space-2) 0;font-size:var(--type-ui-size)}",
  ":where(th,td){padding:var(--space-2) var(--space-3) var(--space-2) 0;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}",
  ":where(tr:last-child>td){border-bottom:0}",
  ":where(th){color:var(--muted);font-family:var(--font-ui);font-weight:var(--type-label-weight)}",
  ":where(button,input,select,textarea){font-family:var(--font-ui);font-size:var(--type-ui-size);color:var(--ink);box-sizing:border-box}",
  ":where(button,input[type=button],input[type=submit],input[type=reset]){height:var(--control-md);padding:0 var(--space-4);border:0;border-radius:var(--radius-pill);background:var(--selected);font-weight:var(--type-label-weight);cursor:pointer}",
  ":where(button:hover,input[type=button]:hover,input[type=submit]:hover,input[type=reset]:hover){background:color-mix(in srgb,var(--selected),var(--ink) 7%)}",
  ":where(button:disabled,input:disabled,select:disabled,textarea:disabled){opacity:.4;cursor:default}",
  ":where(input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=button],[type=submit],[type=reset],[type=file]),select){height:var(--control-md);padding:0 var(--space-3);border:0;border-radius:var(--radius-md);background:var(--selected)}",
  ":where(textarea){padding:var(--space-2) var(--space-3);border:0;border-radius:var(--radius-md);background:var(--selected)}",
  ":where(::placeholder){color:var(--muted)}",
  ":where(input[type=checkbox],input[type=radio],input[type=range],progress,meter){accent-color:var(--button)}",
  ":where(:focus){outline:none}:where(:focus-visible){outline:2px solid var(--focus-ring);outline-offset:2px}",
].join("");

function baseStyle(t: HtmlPreviewTheme, document: boolean): string {
  const vars = Object.entries(t.tokens ?? {}).map(([k, v]) => `${k}:${cssValue(v)}`).join(";");
  return `<style>${t.fontFaces ?? ""}:root{color-scheme:${t.scheme};${vars}}` + BASED_BASE +
    `:where(body){color:${cssValue(t.color)};font-family:${cssValue(t.fontFamily)};font-size:${cssValue(t.fontSize)};line-height:${cssValue(t.lineHeight)}` +
    // ein Schnipsel liegt mit Innenabstand auf der Karte; eine ganze Datei füllt sie bis an den Rand
    (document ? "}" : ";padding:var(--space-3) var(--space-4)}") + "</style>";
}

// Meldet die Höhe des Inhalts an die Seite (höchstens einmal pro Bild). Seiten, deren Höhe am Fenster hängt
// (`min-height: 100vh` plus Abstand), würden mit jedem Wachsen weiterwachsen: wächst der Überstand genau mit dem
// Fenster mit, hört der Rahmen auf zu wachsen und rollt stattdessen selbst.
const HEIGHT_SCRIPT = `<script>(()=>{let last=-1,lastVh=-1,lastOver=null,bound=false,queued=false;` +
  `const measure=()=>{queued=false;const b=document.body;if(!b)return;const s=getComputedStyle(b);` +
  `const h=Math.ceil(b.getBoundingClientRect().height+(parseFloat(s.marginTop)||0)+(parseFloat(s.marginBottom)||0));` +
  `const vh=innerHeight,over=h-vh;` +
  `if(over>0&&lastOver!==null&&vh>lastVh&&Math.abs(over-lastOver)<=1)bound=true;if(over<=0)bound=false;` +
  `lastVh=vh;lastOver=over>0?over:null;if(bound&&over>0)return;if(h===last)return;last=h;` +
  `parent.postMessage({${HTML_PREVIEW_HEIGHT_KEY}:h},"*")};` +
  `const post=()=>{if(!queued){queued=true;requestAnimationFrame(measure)}};` +
  `addEventListener("DOMContentLoaded",()=>{post();const r=new ResizeObserver(post);r.observe(document.body);r.observe(document.documentElement);` +
  `new MutationObserver(post).observe(document.body,{childList:true,subtree:true,characterData:true})});` +
  `addEventListener("load",post);addEventListener("resize",post)})()</script>`;

/** Inhalt des Rahmens: CSP vorneweg, Grundstil in Based-Optik, Höhenmeldung, dann der Code (der alles überschreiben darf). */
export function htmlPreviewDoc(code: string, theme?: HtmlPreviewTheme): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">` +
    (theme ? baseStyle(theme, isHtmlDocument(code)) : "") + HEIGHT_SCRIPT + code;
}

/** Höhe aus einer Meldung des Rahmens, begrenzt; `undefined`, wenn die Nachricht keine ist. */
export function htmlPreviewHeight(data: unknown): number | undefined {
  const h = typeof data === "object" && data !== null ? (data as Record<string, unknown>)[HTML_PREVIEW_HEIGHT_KEY] : undefined;
  if (typeof h !== "number" || !Number.isFinite(h)) return undefined;
  return Math.min(Math.max(Math.round(h), HTML_PREVIEW_HEIGHT.min), HTML_PREVIEW_HEIGHT.max);
}

// Zuletzt gemessene Höhe je Inhalt: ein neu gezeichneter Block (Neuladen der Ansicht, Wechsel der Ansicht) springt
// nicht erst auf die Anfangshöhe und dann auf die richtige.
const lastHeights = new Map<string, number>();
function key(code: string): string {
  let h = 5381;
  for (let i = 0; i < code.length; i++) h = ((h << 5) + h + code.charCodeAt(i)) | 0;
  return `${code.length}:${h}`;
}
export function rememberedHeight(code: string): number | undefined {
  return lastHeights.get(key(code));
}
export function rememberHeight(code: string, h: number): void {
  if (lastHeights.size > 200) lastHeights.clear();
  lastHeights.set(key(code), h);
}
