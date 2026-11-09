// Seite → eigenständiges HTML-Dokument (Swift Interop/HTMLExport.swift, `HTMLExporter.export(page:)` und `css`).
import { titleOf } from "../query/engine.js";
import { escapeText, type HTMLExporter } from "./export.js";

/** Stylesheet der exportierten Seiten (Notion-ähnlich, hell/dunkel). */
export const EXPORT_CSS = ":root { color-scheme: light dark; --text: #37352f; --muted: #787774; --line: #e9e9e7; --bg: #ffffff; --soft: #f7f6f3; --accent: #2383e2; }\n@media (prefers-color-scheme: dark) { :root { --text: #e6e6e4; --muted: #9b9b9b; --line: #2f2f2f; --bg: #191919; --soft: #252525; --accent: #529cca; } }\nhtml { background: var(--bg); color: var(--text); }\nbody { margin: 0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, \"Segoe UI\", Helvetica, Arial, sans-serif; }\n.page { max-width: 708px; margin: 0 auto; padding: 64px 24px 96px; }\n.icon { font-size: 64px; line-height: 1; margin-bottom: 8px; }\nh1.title { font-size: 40px; line-height: 1.2; margin: 0 0 24px; }\nh2 { font-size: 1.875em; margin: 1.4em 0 .3em; } h3 { font-size: 1.5em; margin: 1.2em 0 .2em; }\nh4 { font-size: 1.25em; margin: 1em 0 .2em; } h5 { font-size: 1.1em; margin: 1em 0 .2em; }\np { margin: 2px 0; min-height: 1.6em; } p.empty { min-height: 1.6em; }\n.indent { padding-left: 1.6em; }\na { color: inherit; text-decoration: underline; text-decoration-color: var(--muted); }\ncode { font: .85em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--soft); color: #eb5757; padding: .1em .35em; border-radius: 4px; }\npre { background: var(--soft); padding: 16px; border-radius: 6px; overflow-x: auto; }\npre code { background: none; color: inherit; padding: 0; font-size: .85em; }\nblockquote { border-left: 3px solid currentColor; margin: 6px 0; padding: 0 14px; }\nhr { border: 0; border-top: 1px solid var(--line); margin: 16px 0; }\nul, ol { margin: 2px 0; padding-left: 1.6em; } ul.todo { list-style: none; padding-left: .2em; }\nul.todo li.checked > span { text-decoration: line-through; color: var(--muted); }\ndetails { margin: 2px 0; } details > summary { cursor: pointer; } details > summary h2, details > summary h3, details > summary h4, details > summary h5 { display: inline; }\n.callout { display: flex; gap: 10px; background: var(--soft); border-radius: 6px; padding: 16px 16px 16px 12px; margin: 6px 0; }\n.callout-icon { font-size: 1.3em; line-height: 1.2; }\nfigure { margin: 8px 0; } img, video { max-width: 100%; border-radius: 4px; } figcaption, .caption { color: var(--muted); font-size: 14px; }\niframe.embed { width: 100%; height: 420px; border: 1px solid var(--line); border-radius: 6px; }\n.html-block iframe { width: 100%; min-height: 320px; border: 1px solid var(--line); border-radius: 6px; background: transparent; }\n.bookmark { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; margin: 6px 0; text-decoration: none; }\n.bookmark-title { font-weight: 500; } .bookmark-desc, .bookmark-url { color: var(--muted); font-size: 13px; }\n.page-link a { text-decoration: none; border-bottom: 1px solid var(--line); }\n.mention { color: var(--muted); }\ntable { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 14px; }\nth, td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; vertical-align: top; }\nth { color: var(--muted); font-weight: 500; }\ntable.properties { width: auto; margin-bottom: 24px; } table.properties th, table.properties td { border: 0; padding: 3px 12px 3px 0; }\n.db-title { margin-top: 1.4em; }\n.columns { display: flex; gap: 24px; } .column { flex: 1; min-width: 0; }\n.equation { text-align: center; margin: 8px 0; overflow-x: auto; } .equation.inline { display: inline; }\n.color-gray { color: #787774; } .color-brown { color: #9f6b53; } .color-orange { color: #d9730d; } .color-yellow { color: #cb912f; }\n.color-green { color: #448361; } .color-blue { color: #337ea9; } .color-purple { color: #9065b0; } .color-pink { color: #c14c8a; } .color-red { color: #d44c47; }\n.color-grayBackground { background: #f1f1ef; } .color-brownBackground { background: #f4eeee; } .color-orangeBackground { background: #fbecdd; }\n.color-yellowBackground { background: #fbf3db; } .color-greenBackground { background: #edf3ec; } .color-blueBackground { background: #e7f3f8; }\n.color-purpleBackground { background: rgba(244,240,247,.8); } .color-pinkBackground { background: rgba(249,238,243,.8); } .color-redBackground { background: #fdebec; }\n@media (prefers-color-scheme: dark) { [class*=\"Background\"] { background: rgba(255,255,255,.08); } }\n@media print { .page { padding: 0; } iframe { display: none; } }";

/** Ganze Seite als HTML-Dokument; Datenbank-Container als Tabelle ihrer Zeilen. */
export function exportHTMLPage(exporter: HTMLExporter, id: string): string {
  const store = exporter.store;
  const page = store.blocks.get(id);
  if (!page) return "";
  const title = titleOf(store, id);
  const t = escapeText(title === "" ? "Untitled" : title);
  let body = "";
  if (typeof page.props?.icon === "string") body += `<div class="icon">${escapeText(page.props.icon)}</div>\n`;
  body += `<h1 class="title">${t}</h1>\n`;
  body += exporter.properties(page);
  if (page.type === "databasePage" || page.type === "databaseInline") body += exporter.database(page);
  else body += exporter.blocks(exporter.contentBlocks(id));
  const usesMath = body.includes("class=\"equation\"");
  const usesMermaid = body.includes("class=\"mermaid\"");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Based">
<title>${t}</title>
<style>${EXPORT_CSS}</style>
${usesMath ? "<script src=\"https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js\" async></script>" : ""}
</head>
<body>
<article class="page">
${body}</article>
${usesMermaid ? "<script type=\"module\">import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'; mermaid.initialize({ startOnLoad: true, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default', securityLevel: 'strict' });</script>" : ""}
</body>
</html>
`;
}
