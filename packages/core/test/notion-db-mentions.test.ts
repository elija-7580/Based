// BSD-377 (Mac 13.11., Elijás Second Brain): Erwähnungen von Inline-Datenbanken erschienen nach dem Notion-Import als
// „deleted“ (sie zeigten auf die Notion-ID der Datenbank, der Block hat die ID der Tabelle), und eine Seite, die nur
// Inline-Datenbanken enthält, zeigte in der Seitenleiste „No pages inside“. Nachgebaut im Aufbau des Notion-HTML-Exports.
import { describe, expect, it } from "vitest";
import { buildOutline, ImportFiles, importNotionItems, MemoryPersistence, WorkspaceStore, type Block } from "../src/index.js";

const PAGE = "11111111-1111-4111-8111-111111111111";
const DB = "22222222-2222-4222-8222-222222222222";
const DIV = "33333333-3333-4333-8333-333333333333";
const ROW = "44444444-4444-4444-8444-444444444444";
const LINKED_DIV = "55555555-5555-4555-8555-555555555555";
const bare = (id: string) => id.replaceAll("-", "");
const enc = new TextEncoder();
const doc = (id: string, title: string, body: string) =>
  `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>${title}</title></head><body><article id="${id}" class="page sans"><header><h1 class="page-title">${title}</h1></header><div class="page-body">${body}</div></article></body></html>`;

function exportFiles(): ImportFiles {
  const pageName = `Second Brain ${bare(PAGE)}`;
  const dbFolder = `SB_People ${bare(DB)}`;
  const rowHref = `${encodeURIComponent(dbFolder)}/${encodeURIComponent(`Alice ${bare(ROW)}`)}.html`;
  const table = `<table class="collection-content"><thead><tr><th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th></tr></thead><tbody><tr id="${ROW}"><td class="cell-title"><a href="${rowHref}">Alice</a></td></tr></tbody></table>`;
  const body = [
    `<figure class="callout" style="white-space:pre-wrap;display:flex" id="66666666-6666-4666-8666-666666666666"><div style="font-size:1.5em"><span class="icon">⚠️</span></div><div style="width:100%">Do not delete: <a href="${encodeURIComponent(dbFolder)}.html">SB_People</a> and <a href="https://www.notion.so/${bare(DB)}?v=abc">SB_People</a></div></figure>`,
    `<div id="${DIV}" class="collection-content"><h4 class="collection-title">SB_People</h4>${table}</div>`,
    `<figure class="link-to-page"><a href="${encodeURIComponent(dbFolder)}.html">SB_People</a></figure>`,
    // Verknüpfte Ansicht derselben Datenbank: erscheint nicht als eigener Eintrag in der Seitenleiste.
    `<div id="${LINKED_DIV}" class="collection-content"><h4 class="collection-title">People view</h4>${table}</div>`,
  ].join("\n");
  return new ImportFiles([
    [`${pageName}.html`, enc.encode(doc(PAGE, "Second Brain", body))],
    [`${pageName}/${dbFolder}/Alice ${bare(ROW)}.html`, enc.encode(doc(ROW, "Alice", "<p>row</p>"))],
  ]);
}

describe.each([false, true])("BSD-377: Datenbanken aus dem Notion-Export (propertyRecords=%s)", (propertyRecords) => {
  const run = () => {
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "n", propertyRecords });
    importNotionItems(store, [{ files: exportFiles(), path: `Second Brain ${bare(PAGE)}.html` }]);
    return store;
  };

  it("Erwähnungen, Seitenlinks und Link-Blöcke auf eine Inline-Datenbank zeigen auf ihren Block", () => {
    const store = run();
    const container = [...store.blocks.values()].find((b) => b.type === "databaseInline" && store.databases.get(b.props?.databaseID ?? "")?.blockID === b.id)!;
    expect(container).toBeDefined();
    expect(store.children("d:" + container.props!.databaseID!)).toHaveLength(1);
    const callout = [...store.blocks.values()].find((b) => b.type === "callout")!;
    const targets = (callout.text as { mention?: { page?: { _0: string } }; m?: { link?: string } }[])
      .map((r) => r.mention?.page?._0 ?? r.m?.link?.replace("based://page/", ""))
      .filter((x): x is string => x !== undefined);
    expect(targets.length).toBeGreaterThanOrEqual(2);
    for (const t of targets) expect(store.blocks.has(t)).toBe(true);
    expect(targets.every((t) => t === container.id)).toBe(true);
    const link = [...store.blocks.values()].find((b: Block) => b.type === "linkToPage");
    if (link) expect(link.props?.linkTarget).toBe(container.id);
  });

  it("Seitenleiste: die Seite zeigt ihre Inline-Datenbank (nicht „No pages inside“), verknüpfte Ansichten nicht", () => {
    const store = run();
    const page = [...store.blocks.values()].find((b) => b.type === "page" && b.parent === "w")!;
    const outline = buildOutline(store);
    const kids = outline.children[page.id] ?? [];
    const dbs = kids.filter((k) => outline.nodes[k]?.kind === "database");
    expect(dbs).toHaveLength(1);
    expect(outline.nodes[dbs[0]!]).toMatchObject({ kind: "database", parent: page.id });
    expect(store.blocks.get(dbs[0]!)!.type).toBe("databaseInline");
  });
});
