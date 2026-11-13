// BSD-209: Codeblock mit Sprachwahl (BlockNote-Kern `createCodeBlockSpec`, Sprachen aus @based/core), Hervorhebung
// offline über den Swift-Hervorheber (`syntaxTokens`) als ProseMirror-Dekorationen, und HTML-Vorschau unter dem Code
// in einem abgeschotteten iframe (sandbox ohne allow-same-origin = eigene Origin, CSP: kein Netz). Die Vorschau ist
// ein Widget (BlockNote 0.57 nutzt `createPreview` der Sprachoptionen noch nicht).
import { createCodeBlockSpec, createExtension } from "@blocknote/core";
import { CODE_LANGUAGES, syntaxTokens } from "@based/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { mermaidPreview } from "./mermaid.js";
import { menuIconPath } from "../ui/menuIcons.js";

/** Kein Netz, keine Formulare nach außen; Skripte nur im abgeschotteten Rahmen. */
export const HTML_PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:";

/** Inhalt des Vorschau-Rahmens: CSP vorneweg, dann der Code. */
export function htmlPreviewDoc(code: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">${code}`;
}

/** Vorschau-Rahmen für HTML-Code: sandbox ohne allow-same-origin (eigene, undurchsichtige Origin), kein Referrer. */
export function htmlPreviewFrame(code: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "bx-html-preview-wrap";
  wrap.contentEditable = "false";
  const label = document.createElement("div");
  label.className = "bx-html-preview-label";
  label.textContent = "Preview";
  const frame = document.createElement("iframe");
  frame.className = "bx-html-preview";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("title", "HTML preview");
  frame.srcdoc = htmlPreviewDoc(code);
  wrap.append(label, frame);
  return wrap;
}

/** Zuletzt mit dem Kopierknopf eines Codeblocks kopiert (für Tests und Umgebungen ohne Zwischenablage-Recht). */
export let lastCodeCopy = "";

const SVG = "http://www.w3.org/2000/svg";
function icon(name: "duplicate" | "check" | "wrap"): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "bx-menu-icon");
  const path = document.createElementNS(SVG, "path");
  for (const [k, v] of [["d", menuIconPath(name)], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]] as const) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}

function toolButton(cls: string, label: string, iconName: "duplicate" | "check" | "wrap"): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "bx-code-tool " + cls;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.append(icon(iconName));
  b.addEventListener("mousedown", (e) => e.preventDefault()); // Schreibmarke bleibt, wo sie ist
  return b;
}

/**
 * Leiste oben rechts im Codeblock (wie Notion), sichtbar beim Überfahren oder mit Tastaturfokus: Zeilenumbruch
 * an/aus und Kopieren. Liest den Block beim Klick aus dem Dokument; neu gezeichnet wird sie nur, wenn sich der
 * Umbruch ändert (Schlüssel der Dekoration).
 */
export function codeTools(wrap: boolean): (view: EditorView, getPos: () => number | undefined) => HTMLElement {
  return (view, getPos) => {
    const bar = document.createElement("span");
    bar.className = "bx-code-tools";
    bar.contentEditable = "false";
    const block = () => {
      const pos = getPos();
      if (pos === undefined) return undefined;
      const $pos = view.state.doc.resolve(pos);
      return $pos.parent.type.name === "codeBlock" ? { node: $pos.parent, at: $pos.before() } : undefined;
    };
    const wrapButton = toolButton("bx-code-wrap", "Wrap code", "wrap");
    wrapButton.setAttribute("aria-pressed", String(wrap));
    wrapButton.addEventListener("click", (e) => {
      e.preventDefault();
      const b = block();
      if (b && view.editable) view.dispatch(view.state.tr.setNodeAttribute(b.at, "wrap", !wrap));
    });
    const copy = toolButton("bx-code-copy", "Copy code", "duplicate");
    let reset: ReturnType<typeof setTimeout> | undefined;
    copy.addEventListener("click", (e) => {
      e.preventDefault();
      const b = block();
      if (!b) return;
      lastCodeCopy = b.node.textContent;
      const show = (name: "duplicate" | "check", label: string) => {
        copy.replaceChildren(icon(name));
        copy.setAttribute("aria-label", label);
        copy.title = label;
      };
      const done = (ok: boolean) => {
        show(ok ? "check" : "duplicate", ok ? "Copied" : "Couldn’t copy");
        if (reset !== undefined) clearTimeout(reset);
        reset = setTimeout(() => show("duplicate", "Copy code"), 1500);
      };
      const clip = globalThis.navigator?.clipboard;
      if (!clip) done(false);
      else void clip.writeText(lastCodeCopy).then(() => done(true), () => done(false));
    });
    if (view.editable) bar.append(wrapButton);
    bar.append(copy);
    return bar;
  };
}

const languages: Record<string, { name: string; aliases?: string[] }> = {};
for (const l of CODE_LANGUAGES) languages[l.id] = { name: l.name, ...(l.aliases ? { aliases: [...l.aliases] } : {}) };

/** Sprachen mit Vorschau unter dem Code: HTML im abgeschotteten Rahmen, Mermaid als Bild (BSD-209). */
const PREVIEW_LANGUAGES: ReadonlySet<string> = new Set(["html", "mermaid"]);

/**
 * BlockNote wirft beim Zeichnen, wenn die gespeicherte Sprache nicht in der Liste steht („ts“ aus Markdown, Sprachen
 * aus Swift/Notion). Die Liste meldet deshalb jede Sprache als bekannt; im Menü stehen nur die eigenen, die
 * gespeicherte bleibt unverändert (und wird über den Hervorheber trotzdem erkannt).
 */
const anyLanguage = new Proxy(languages, { has: () => true });

const baseSpec = createCodeBlockSpec({ defaultLanguage: "text", indentLineWithTab: true, supportedLanguages: anyLanguage });

/**
 * BlockNotes Codeblock plus `wrap` (Zeilen umbrechen, Standard an; aus = eine Zeile je Codezeile mit waagrechtem
 * Rollen, wie Notions „Wrap code“). Steht als `data-wrap="false"` am Block und als `wrap: false` im Record.
 */
export const codeBlockSpec = {
  ...baseSpec,
  config: { ...baseSpec.config, propSchema: { ...baseSpec.config.propSchema, wrap: { default: true } } },
} as typeof baseSpec;

/** Dekorationen für alle Codeblöcke im Dokument. */
export function syntaxDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    const text = node.textContent;
    const language = String(node.attrs.language ?? "").toLowerCase();
    const wrap = node.attrs.wrap !== false;
    decos.push(Decoration.widget(pos + 1, codeTools(wrap), { side: -1, key: wrap ? "tools:wrap" : "tools:nowrap", ignoreSelection: true }));
    if (text.length > 0 && text.length < 200_000) {
      for (const t of syntaxTokens(text, language)) {
        decos.push(Decoration.inline(pos + 1 + t.from, pos + 1 + t.from + t.length, { class: "bx-tok-" + t.kind }));
      }
    }
    if (PREVIEW_LANGUAGES.has(language) && text.trim() !== "") {
      // Schlüssel = Inhalt: unveränderter Code behält seinen Rahmen (kein Neuladen bei jeder Änderung anderswo).
      const make = language === "mermaid" ? () => mermaidPreview(text) : () => htmlPreviewFrame(text);
      decos.push(Decoration.widget(pos + node.nodeSize - 1, make, { side: 1, key: language + ":" + text, ignoreSelection: true }));
    }
    return false;
  });
  return DecorationSet.create(doc, decos);
}

const key = new PluginKey<DecorationSet>("bx-syntax");

/** Neu berechnet nur, wenn sich das Dokument ändert (der Hervorheber ist ein linearer Durchlauf). */
export const syntaxHighlighting = createExtension({
  key: "bxSyntax",
  prosemirrorPlugins: [
    new Plugin<DecorationSet>({
      key,
      state: {
        init: (_, state) => syntaxDecorations(state.doc),
        apply: (tr, old) => (tr.docChanged ? syntaxDecorations(tr.doc) : old),
      },
      props: { decorations: (state) => key.getState(state) },
    }),
  ],
});
