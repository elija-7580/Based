// BSD-209: Codeblock mit Sprachwahl (BlockNote-Kern `createCodeBlockSpec`, Sprachen aus @based/core), Hervorhebung
// offline über den Swift-Hervorheber (`syntaxTokens`) als ProseMirror-Dekorationen, und HTML-Vorschau unter dem Code
// in einem abgeschotteten iframe (sandbox ohne allow-same-origin = eigene Origin, CSP: kein Netz). Die Vorschau ist
// ein Widget (BlockNote 0.57 nutzt `createPreview` der Sprachoptionen noch nicht).
import { createCodeBlockSpec, createExtension } from "@blocknote/core";
import { CODE_LANGUAGES, syntaxTokens } from "@based/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
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
function icon(name: "duplicate" | "check"): SVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "bx-menu-icon");
  const path = document.createElementNS(SVG, "path");
  for (const [k, v] of [["d", menuIconPath(name)], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]] as const) path.setAttribute(k, v);
  svg.append(path);
  return svg;
}

/**
 * Kopierknopf oben rechts im Codeblock (wie Notion), sichtbar beim Überfahren oder mit Tastaturfokus. Liest den Code
 * beim Klick aus dem Dokument – der Knopf selbst bleibt beim Tippen stehen (fester Schlüssel).
 */
export function codeCopyButton(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "bx-code-copy";
  b.contentEditable = "false";
  b.setAttribute("aria-label", "Copy code");
  b.title = "Copy code";
  b.append(icon("duplicate"));
  let reset: ReturnType<typeof setTimeout> | undefined;
  b.addEventListener("mousedown", (e) => e.preventDefault()); // Schreibmarke bleibt, wo sie ist
  b.addEventListener("click", (e) => {
    e.preventDefault();
    const pos = getPos();
    const node = pos === undefined ? null : view.state.doc.resolve(pos).parent;
    if (!node || node.type.name !== "codeBlock") return;
    lastCodeCopy = node.textContent;
    const done = (ok: boolean) => {
      b.replaceChildren(icon(ok ? "check" : "duplicate"));
      b.setAttribute("aria-label", ok ? "Copied" : "Couldn’t copy");
      b.title = ok ? "Copied" : "Couldn’t copy";
      if (reset !== undefined) clearTimeout(reset);
      reset = setTimeout(() => {
        b.replaceChildren(icon("duplicate"));
        b.setAttribute("aria-label", "Copy code");
        b.title = "Copy code";
      }, 1500);
    };
    const clip = globalThis.navigator?.clipboard;
    if (!clip) done(false);
    else void clip.writeText(lastCodeCopy).then(() => done(true), () => done(false));
  });
  return b;
}

const languages: Record<string, { name: string; aliases?: string[] }> = {};
for (const l of CODE_LANGUAGES) languages[l.id] = { name: l.name, ...(l.aliases ? { aliases: [...l.aliases] } : {}) };

/** Sprachen mit Vorschau unter dem Code (Mermaid folgt, braucht eine gebündelte Bibliothek). */
const PREVIEW_LANGUAGES: ReadonlySet<string> = new Set(["html"]);

/**
 * BlockNote wirft beim Zeichnen, wenn die gespeicherte Sprache nicht in der Liste steht („ts“ aus Markdown, Sprachen
 * aus Swift/Notion). Die Liste meldet deshalb jede Sprache als bekannt; im Menü stehen nur die eigenen, die
 * gespeicherte bleibt unverändert (und wird über den Hervorheber trotzdem erkannt).
 */
const anyLanguage = new Proxy(languages, { has: () => true });

export const codeBlockSpec = createCodeBlockSpec({ defaultLanguage: "text", indentLineWithTab: true, supportedLanguages: anyLanguage });

/** Dekorationen für alle Codeblöcke im Dokument. */
export function syntaxDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "codeBlock") return true;
    const text = node.textContent;
    const language = String(node.attrs.language ?? "").toLowerCase();
    decos.push(Decoration.widget(pos + 1, codeCopyButton, { side: -1, key: "copy", ignoreSelection: true }));
    if (text.length > 0 && text.length < 200_000) {
      for (const t of syntaxTokens(text, language)) {
        decos.push(Decoration.inline(pos + 1 + t.from, pos + 1 + t.from + t.length, { class: "bx-tok-" + t.kind }));
      }
    }
    if (PREVIEW_LANGUAGES.has(language) && text.trim() !== "") {
      // Schlüssel = Inhalt: unveränderter Code behält seinen Rahmen (kein Neuladen bei jeder Änderung anderswo).
      decos.push(Decoration.widget(pos + node.nodeSize - 1, () => htmlPreviewFrame(text), { side: 1, key: "html:" + text, ignoreSelection: true }));
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
