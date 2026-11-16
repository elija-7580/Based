// @vitest-environment node
// BSD-407 Teil 4b: Der kopflose Konverter (Blöcke ⇄ Y-XML für alte `page:`-Dokumente) kommt ohne @blocknote/react aus.
// Damit alte Dokumente gleich gelesen und geschrieben werden, hält dieser Test die Y-XML-Ausgabe für jeden Blocktyp,
// jede Eigenschaft und jeden Inline-Inhalt fest (Schnappschuss mit dem bisherigen React-Schema erzeugt) – und die
// Rundreise Y-XML → Blöcke.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createConverter } from "../src/headless.js";
import { CUSTOM, INLINE, type BNBlock } from "../src/mapping/bn.js";
import { projectDoc } from "../src/mapping/blocks.js";
import { corpusStore } from "./helpers.js";

const p = (id: string, text: string) => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
const atom = (id: string, type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({ id, type, props, content: undefined, children });

/** Jeder eigene Blocktyp mit gesetzten (nicht voreingestellten) Eigenschaften, dazu beide Inline-Inhalte. */
const custom = [
  { id: "co", type: CUSTOM.callout, props: { textColor: "red", backgroundColor: "blue_background", icon: "🔥" }, content: [{ type: "text", text: "Callout", styles: { italic: true } }], children: [p("co-k", "Kind")] },
  atom("eq", CUSTOM.equation, { expression: "e^{i\\pi}+1=0" }),
  atom("pg", CUSTOM.page, { variant: "database" }),
  atom("lp", CUSTOM.linkToPage, { target: "pg" }),
  atom("sy", CUSTOM.syncedBlock, { source: "orig" }, [p("sy-k", "synchron")]),
  atom("db", CUSTOM.database, { databaseID: "d1", viewID: "v1" }),
  atom("em", CUSTOM.embed, { kind: "bookmark", url: "https://example.com", meta: "{\"title\":\"Ex\"}" }),
  atom("toc", CUSTOM.toc),
  atom("bc", CUSTOM.breadcrumb),
  atom("bt", CUSTOM.button),
  atom("cl", CUSTOM.columnList, {}, [atom("c1", CUSTOM.column, { width: 0.4 }, [p("c1-k", "links")]), atom("c2", CUSTOM.column, {}, [p("c2-k", "rechts")])]),
  atom("mt", CUSTOM.meeting),
  atom("op", CUSTOM.opaque, { blockType: "future", raw: "{\"x\":1}" }),
  {
    id: "in", type: "paragraph", props: {}, children: [],
    content: [
      { type: "text", text: "Siehe ", styles: {} },
      { type: INLINE.mention, props: { kind: "page", value: "pg", text: "Seite" } },
      { type: "text", text: " und ", styles: { bold: true } },
      { type: INLINE.equation, props: { expression: "a^2", text: "a^2" } },
      { type: INLINE.mention, props: { kind: "date", value: "2026-11-16", text: "" } },
    ],
  },
  { id: "h4", type: "heading", props: { level: 4, isToggleable: true }, content: [{ type: "text", text: "H4", styles: {} }], children: [p("h4-k", "drin")] },
  { id: "cb", type: "codeBlock", props: { language: "typescript" }, content: [{ type: "text", text: "const a = 1;", styles: {} }], children: [] },
] as unknown as BNBlock[];

function roundTrip(blocks: readonly BNBlock[]) {
  const c = createConverter();
  const doc = new Y.Doc();
  const f = doc.getXmlFragment("doc");
  c.toFragment(blocks, f);
  return { xml: f.toJSON(), back: c.fromFragment(f) };
}

describe("Konverter Y-XML (BSD-407 Teil 4b)", () => {
  it("eigene Blöcke und Inline-Inhalte: Y-XML unverändert, Rundreise verlustfrei", () => {
    const { xml, back } = roundTrip(custom);
    expect(xml).toMatchSnapshot();
    expect(back).toMatchSnapshot();
    expect(back.map((b) => b.id)).toEqual(custom.map((b) => b.id));
  });

  it("Swift-Korpus: jede Seite ergibt dasselbe Y-XML wie bisher", () => {
    const store = corpusStore();
    const pages = [...store.blocks.values()].filter((b) => b.type === "page").map((b) => b.id).sort();
    expect(pages.length).toBeGreaterThan(0);
    for (const id of pages) {
      const { xml, back } = roundTrip(projectDoc(store, id));
      expect(xml).toMatchSnapshot(`page ${id}`);
      expect(back).toMatchSnapshot(`page ${id} zurück`);
    }
  });
});
