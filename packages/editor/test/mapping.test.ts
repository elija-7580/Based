// BSD-154: Records ⇄ BlockNote-Blöcke (rein, ohne Y.Doc).
import { describe, expect, it } from "vitest";
import { canonicalStringify, parseRecord, type Block } from "@based/core";
import { bookmarkMeta, docBlockIDs, mediaAlign, projectDoc } from "../src/mapping/blocks.js";
import { materializeDoc } from "../src/mapping/materialize.js";
import { canonicalRichText, inlineToRichText, richTextToInline } from "../src/mapping/richtext.js";
import { assignSortKeys } from "../src/mapping/sortkeys.js";
import { corpusStore } from "./helpers.js";

describe("Mapping", () => {
  it("Korpus: Records → Blöcke → Records ohne Änderung", () => {
    const store = corpusStore();
    const blocks = projectDoc(store, "p-root");
    const changes = materializeDoc(store, "p-root", blocks, { now: 1 });
    expect(changes.puts.map((b) => b.id)).toEqual([]);
    expect(changes.removeBlocks).toEqual([]);
  });

  it("Bildbreite (BSD-168/290): previewWidth ⇄ props.width wie Swift (Wert unverändert durchgereicht)", () => {
    const store = corpusStore();
    const blocks = projectDoc(store, "p-root");
    const find = (list: typeof blocks): (typeof blocks)[number] | undefined => {
      for (const b of list) {
        if (b.id === "bima-0017-0000-4000-8000-000000000000") return b;
        const c = find((b.children ?? []) as typeof blocks);
        if (c) return c;
      }
      return undefined;
    };
    const img = find(blocks)!;
    expect(img.type).toBe("image");
    expect((img.props as Record<string, unknown>).previewWidth).toBe(0.75);
    (img.props as Record<string, unknown>).previewWidth = 312;
    const changes = materializeDoc(store, "p-root", blocks, { now: 1 });
    const put = changes.puts.find((b) => b.id === img.id)!;
    expect(put.props?.width).toBe(312);
    expect(put.props?.asset?.id).toBe("asset-3");
  });

  it("BSD-290: Ausrichtung eines Bildes ⇄ props.align; alte Records ohne align bleiben unverändert (links)", () => {
    const store = corpusStore();
    const blocks = projectDoc(store, "p-root");
    const find = (list: typeof blocks): (typeof blocks)[number] | undefined => {
      for (const b of list) {
        if (b.id === "bima-0017-0000-4000-8000-000000000000") return b;
        const c = find((b.children ?? []) as typeof blocks);
        if (c) return c;
      }
      return undefined;
    };
    const img = find(blocks)!;
    const props = img.props as Record<string, unknown>;
    // alter Stand: kein align im Record → links, und das Zurückschreiben ändert nichts
    expect(store.blocks.get(img.id)!.props?.align).toBeUndefined();
    expect(props.textAlignment).toBe("left");
    expect(materializeDoc(store, "p-root", blocks, { now: 1 }).puts).toEqual([]);
    props.textAlignment = "center";
    const put = materializeDoc(store, "p-root", blocks, { now: 1 }).puts.find((b) => b.id === img.id)!;
    expect(put.props?.align).toBe("center");
    expect(put.props?.caption).toEqual(store.blocks.get(img.id)!.props?.caption); // Caption (richText) bleibt erhalten
    // „left“ (Vorgabe) und Unbekanntes werden nicht gespeichert
    expect([mediaAlign("left"), mediaAlign("justify"), mediaAlign(undefined), mediaAlign("right")]).toEqual([undefined, undefined, undefined, "right"]);
  });

  it("BSD-209: Bookmark-Vorschau ⇄ props.bookmark; ohne Vorschau bleibt der Record unverändert", () => {
    expect(bookmarkMeta(canonicalStringify({ title: "T", summary: "S" }))).toEqual({ title: "T", summary: "S" });
    expect([bookmarkMeta(""), bookmarkMeta("{}"), bookmarkMeta("[1]"), bookmarkMeta("{oops"), bookmarkMeta(undefined)]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    const bm: Block = { id: "bm-1", type: "bookmark", parent: "b:p-root", sk: "zz", props: { url: "https://example.com", bookmark: { title: "Example", imageURL: "https://example.com/i.png" } }, createdAt: 1, updatedAt: 1 } as Block;
    const store = corpusStore([parseRecord({ kind: "block", data: bm })]);
    const blocks = projectDoc(store, "p-root");
    const bn = blocks.find((b) => b.id === "bm-1")!;
    expect(JSON.parse(String((bn.props as Record<string, unknown>).meta))).toEqual({ title: "Example", imageURL: "https://example.com/i.png" });
    expect(materializeDoc(store, "p-root", blocks, { now: 1 }).puts).toEqual([]);
    (bn.props as Record<string, unknown>).meta = canonicalStringify({ title: "New", summary: "Fresh" });
    const put = materializeDoc(store, "p-root", blocks, { now: 2 }).puts.find((b) => b.id === "bm-1")!;
    expect(put.props?.bookmark).toEqual({ title: "New", summary: "Fresh" });
    expect(put.props?.url).toBe("https://example.com");
  });

  it("richText mit allen Marken, Erwähnungen und Gleichung", () => {
    const store = corpusStore();
    const runs = store.blocks.get("btex-0002-0000-4000-8000-000000000000")!.text!;
    expect(inlineToRichText(richTextToInline(runs))).toEqual(canonicalRichText(runs));
    expect(inlineToRichText(richTextToInline("x"))).toBe("x");
    expect(inlineToRichText([])).toBeUndefined();
  });

  it("Sortierschlüssel bleiben, nur Verschobenes bekommt neue", () => {
    expect(assignSortKeys(["a", "b", "c"], ["a0", "a1", "a2"])).toEqual(["a0", "a1", "a2"]);
    const moved = assignSortKeys(["c", "a", "b"], ["a2", "a0", "a1"]);
    expect(moved.slice(1)).toEqual(["a0", "a1"]);
    expect(moved[0]! < "a0").toBe(true);
    const ins = assignSortKeys(["a", "x", "b"], ["a0", undefined, "a1"]);
    expect(ins[0]).toBe("a0");
    expect(ins[2]).toBe("a1");
    expect(ins[1]! > "a0" && ins[1]! < "a1").toBe(true);
    // gleiche Schlüssel mit etwas dazwischen
    const dup = assignSortKeys(["a", "x", "b"], ["a1", undefined, "a1"]);
    expect(dup[0]! < dup[1]! && dup[1]! < dup[2]!).toBe(true);
  });

  it("Dokument zeigt Tabellenzeilen, aber keine Kinder von Unterseiten", () => {
    const store = corpusStore();
    const ids = docBlockIDs(store, "p-root");
    expect(ids.has("p-asset")).toBe(true);
    expect(ids.has("btab-0029-0000-4000-8000-000000000000")).toBe(true);
    void (null as unknown as Block);
    void canonicalStringify;
  });

  it("BSD-210: Kinder eines Buttons sind seine Vorlage, nicht Teil der Seite; alte Y-Stände mit Kindern verlieren nichts", async () => {
    const { MemoryPersistence, WorkspaceStore } = await import("@based/core");
    const mk = (id: string, type: string, parent: string, sk: string, text?: string) => ({ kind: "block" as const, data: { id, type, parent, sk, createdAt: 0, updatedAt: 0, ...(text ? { text } : {}) } as Block });
    const store = new WorkspaceStore({ persistence: new MemoryPersistence([mk("p", "page", "w", "a0"), mk("b", "button", "b:p", "a0"), mk("t", "text", "b:b", "a0", "Vorlage")]), node: "n" });
    const doc = projectDoc(store, "p");
    expect(doc).toHaveLength(1);
    expect(doc[0]!.children).toEqual([]);
    expect(docBlockIDs(store, "p").has("t")).toBe(false);
    // Ein alter Y-Stand hatte die Vorlage noch verschachtelt im Seitendokument: sie bleibt beim Button.
    const old = [{ ...doc[0]!, children: [{ id: "t", type: "paragraph", props: {}, content: [{ type: "text", text: "Vorlage", styles: {} }], children: [] }] }];
    const ch = materializeDoc(store, "p", old as never, { now: 1 });
    expect(ch.removeBlocks).toEqual([]);
    expect(ch.puts.find((b) => b.id === "t")?.parent ?? "b:b").toBe("b:b");
    // Ohne Kinder im Dokument wird die Vorlage nicht gelöscht.
    expect(materializeDoc(store, "p", doc, { now: 1 }).removeBlocks).toEqual([]);
    expect(projectDoc(store, "b").map((b) => b.id)).toEqual(["t"]);
  });
});
