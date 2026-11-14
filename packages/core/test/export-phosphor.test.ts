// BSD-409: Phosphor-Icons („phosphor:<name>:<farbe>“, BSD-376) sind kein Text – Markdown (Front-Matter und Callout)
// und das HTML-Dokument lassen sie weg wie der HTML-Exporter; Emoji-Icons bleiben.
import { describe, expect, it } from "vitest";
import { createPage, exportHTMLPage, HTMLExporter, MarkdownExporter, MemoryPersistence, phosphorIcon, setPageIcon, WorkspaceStore } from "../src/index.js";
import { insertBlock } from "../src/editor/commands/blocks.js";

function page(icon: string, calloutIcon: string) {
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
  const id = createPage(s, { title: "Plan" });
  setPageIcon(s, id, icon);
  insertBlock(s, { inside: id }, "callout", { props: { icon: calloutIcon }, text: "Heads up" });
  return { s, id };
}

describe("Export ohne Phosphor-Text", () => {
  it("Phosphor: kein „phosphor:“ in Markdown (mit Front-Matter) und im HTML-Dokument", () => {
    const { s, id } = page(phosphorIcon("star", "blue"), phosphorIcon("warning"));
    const md = new MarkdownExporter(s, { frontmatter: true }).export(id);
    expect(md).not.toContain("phosphor:");
    expect(md).toContain("<aside>\nHeads up");
    const html = exportHTMLPage(new HTMLExporter(s), id);
    expect(html).not.toContain("phosphor:");
    expect(html).not.toContain(`<div class="icon">`);
  });

  it("Emoji bleiben", () => {
    const { s, id } = page("🚀", "⚠️");
    const md = new MarkdownExporter(s, { frontmatter: true }).export(id);
    expect(md).toContain("icon: \"🚀\"");
    expect(md).toContain("<aside>\n⚠️ Heads up");
    expect(exportHTMLPage(new HTMLExporter(s), id)).toContain(`<div class="icon">🚀</div>`);
  });
});
