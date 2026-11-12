// BSD-209: Mermaid-Vorschau unter einem Codeblock mit Sprache „mermaid“ (wie die Swift-App und Notion „Code | Preview“).
// Mermaid ist gebündelt und wird erst beim ersten Diagramm geladen (eigener Chunk); nichts kommt von fremden Servern.
// securityLevel „strict“, Beschriftungen als reines SVG (htmlLabels aus). Das fertige SVG wird nur als Bild gezeigt
// (<img> mit blob:-URL): ein Bild führt keine Skripte aus und erreicht die App nicht. Farben aus den Based-Tokens;
// beim Umschalten hell/dunkel zeichnen sich die Vorschauen neu.

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | undefined;
const load = () => (loading ??= import("mermaid").then((m) => m.default));

/** Gezeichnete Diagramme je Theme und Code (kleiner Zwischenspeicher, damit Neuzeichnen beim Tippen anderswo nichts kostet). */
const cache = new Map<string, Promise<string>>();
const CACHE_MAX = 40;
let counter = 0;

function theme(): "dark" | "light" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Farben aus den Tokens (berechnete Werte, damit Mermaid sie lesen kann). */
function themeVariables(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const ink = v("--ink"), bg = v("--bg"), line = v("--line"), soft = v("--surface-raised") || bg, muted = v("--muted");
  return {
    background: bg, primaryColor: soft, primaryTextColor: ink, primaryBorderColor: line, lineColor: muted,
    secondaryColor: soft, tertiaryColor: bg, textColor: ink, mainBkg: soft, nodeBorder: line, clusterBkg: bg,
    clusterBorder: line, edgeLabelBackground: bg, titleColor: ink, noteBkgColor: soft, noteTextColor: ink, noteBorderColor: line,
    fontFamily: v("--font-ui") || "inherit",
  };
}

/** Mermaid-Code → SVG-Text. Wirft mit Mermaids Meldung, wenn der Code kein gültiges Diagramm ist. */
export async function renderMermaid(code: string): Promise<string> {
  const key = theme() + "\n" + code;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const mermaid = await load();
      mermaid.initialize({
        startOnLoad: false, securityLevel: "strict", theme: "base", themeVariables: themeVariables(), htmlLabels: false,
        flowchart: { htmlLabels: false }, deterministicIds: true,
      });
      const { svg } = await mermaid.render("bx-mermaid-" + ++counter, code);
      return svg;
    })();
    cache.set(key, hit);
    hit.catch(() => cache.delete(key));
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return hit;
}

/** Erste Zeile einer Mermaid-Fehlermeldung, ohne Zeilennummern-Grafik. */
export function mermaidErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const first = raw.split("\n").find((l) => l.trim() !== "" && !/^-+\^?$/.test(l.trim())) ?? "";
  return first.length > 160 ? first.slice(0, 159) + "…" : first;
}

const live = new Set<HTMLElement>();
let observer: MutationObserver | undefined;

function watchTheme() {
  if (observer || typeof MutationObserver === "undefined") return;
  observer = new MutationObserver(() => {
    for (const el of [...live]) {
      if (!el.isConnected) live.delete(el);
      else void draw(el);
    }
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

async function draw(wrap: HTMLElement) {
  const code = wrap.dataset.code ?? "";
  const body = wrap.querySelector<HTMLElement>(".bx-mermaid-body")!;
  wrap.dataset.state = "loading";
  try {
    const svg = await renderMermaid(code);
    if (wrap.dataset.code !== code) return;
    const img = document.createElement("img");
    img.className = "bx-mermaid-image";
    img.alt = "Mermaid diagram";
    img.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const old = body.querySelector("img");
    if (old) URL.revokeObjectURL(old.src);
    body.replaceChildren(img);
    wrap.dataset.state = "ready";
  } catch (e) {
    const msg = document.createElement("div");
    msg.className = "bx-mermaid-error";
    msg.textContent = "Can’t draw this diagram. " + mermaidErrorText(e);
    body.replaceChildren(msg);
    wrap.dataset.state = "error";
  }
}

/** Vorschau-Element (Widget-Dekoration) für Mermaid-Code. */
export function mermaidPreview(code: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "bx-html-preview-wrap bx-mermaid";
  wrap.contentEditable = "false";
  wrap.dataset.code = code;
  wrap.setAttribute("data-testid", "mermaid-preview");
  const label = document.createElement("div");
  label.className = "bx-html-preview-label";
  label.textContent = "Preview";
  const body = document.createElement("div");
  body.className = "bx-mermaid-body";
  wrap.append(label, body);
  for (const el of live) if (!el.isConnected) live.delete(el);
  live.add(wrap);
  watchTheme();
  void draw(wrap);
  return wrap;
}
