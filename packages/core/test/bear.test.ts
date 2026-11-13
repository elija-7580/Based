// BSD-260 Teil 9: Bear-Export (TextBundles und Markdown) importieren – Bundle = Notiz mit Titel aus dem Bundle-Namen,
// Anhänge aus assets/, [[Links]] zwischen Notizen, ::Hervorheben:: und ==Hervorheben== als gelber Hintergrund.
import { describe, expect, it } from "vitest";
import {
  findObsidianVault, highlightToMark, ImportFiles, importNotionItems, isBearExport, MemoryAssetSink, MemoryPersistence, plainText, WorkspaceStore, type Block,
} from "../src/index.js";

const enc = new TextEncoder();
const files = (map: Record<string, string | Uint8Array>) => new ImportFiles(Object.entries(map).map(([k, v]) => [k, typeof v === "string" ? enc.encode(v) : v] as const));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const EXPORT: Record<string, string | Uint8Array> = {
  "Bear/Groceries.textbundle/text.md": ["# Groceries", "", "- [ ] Milk", "- [x] Bread", "", "::Important:: see [[Recipes]] and `::not code::`", "", "![](assets/photo.png)", "", "#shopping #home/kitchen"].join("\n"),
  "Bear/Groceries.textbundle/info.json": JSON.stringify({ version: 2, type: "net.daringfireball.markdown", transient: true, creatorIdentifier: "net.shinyfrog.bear" }),
  "Bear/Groceries.textbundle/assets/photo.png": PNG,
  "Bear/Recipes.textbundle/text.md": ["# Recipes", "", "Pasta with ==tomatoes==."].join("\n"),
  "Bear/Recipes.textbundle/info.json": JSON.stringify({ version: 2, creatorIdentifier: "net.shinyfrog.bear" }),
};

describe("Bear-Export (BSD-260 Teil 9)", () => {
  it("Hilfen: Erkennen, Hervorheben", () => {
    expect(isBearExport(files(EXPORT), "Bear")).toBe(true);
    expect(findObsidianVault(files(EXPORT), "Bear")).toBe("Bear");
    expect(isBearExport(files({ "x/a.md": "hi" }), "x")).toBe(false);
    expect(highlightToMark("a ==b c== d", false)).toBe("a <mark>b c</mark> d");
    expect(highlightToMark("a ::b:: d", false)).toBe("a ::b:: d");
    expect(highlightToMark("a ::b:: d", true)).toBe("a <mark>b</mark> d");
    expect(highlightToMark("x == y", false)).toBe("x == y");
  });

  it("Import: Bundles als Seiten, To-dos, Link, Bild aus assets/, Hervorheben gelb, Code unberührt", () => {
    const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
    const assets = new MemoryAssetSink();
    importNotionItems(s, [{ files: files(EXPORT), path: "Bear" }], { assets });
    const pages = [...s.blocks.values()].filter((b) => b.type === "page");
    expect(pages.map((p) => plainText(p.text))).toEqual(expect.arrayContaining(["Bear", "Groceries", "Recipes"]));
    expect(pages.map((p) => plainText(p.text))).not.toContain("text");
    expect(pages.map((p) => plainText(p.text))).not.toContain("Groceries.textbundle");
    const page = (t: string) => pages.find((p) => plainText(p.text) === t)!;
    const kids = (p: Block) => s.children("b:" + p.id).map((c) => s.blocks.get(c)!);
    const g = kids(page("Groceries"));
    expect(g.filter((b) => b.type === "todo").map((b) => [plainText(b.text), b.props?.checked === true])).toEqual([["Milk", false], ["Bread", true]]);
    const line = g.find((b) => plainText(b.text).startsWith("Important"))!;
    const runs = line.text as { t: string; m?: { color?: string; c?: boolean }; mention?: { page?: { _0: string } } }[];
    expect(runs[0]).toMatchObject({ t: "Important", m: { color: "yellowBackground" } });
    expect(runs.some((r) => r.mention?.page?._0 === page("Recipes").id)).toBe(true);
    expect(runs.some((r) => r.t === "::not code::" && r.m?.c)).toBe(true);
    const img = g.find((b) => b.type === "image")!;
    expect(img.props?.asset?.name).toBe("photo.png");
    expect(g.some((b) => plainText(b.text).includes("#shopping"))).toBe(true);
    const r = kids(page("Recipes"))[0]!;
    expect(r.text).toEqual([{ t: "Pasta with " }, { t: "tomatoes", m: { color: "yellowBackground" } }, { t: "." }]);
  });
});
