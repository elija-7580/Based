// BSD-260 Teil 3: OPML ⇄ Based – Workflowy-Gliederung (verschachtelt, _note, _complete, Links, HTML im Text),
// Feed-Liste, Rundreise Import → Export → Import, Fehler bei Nicht-OPML.
import { describe, expect, it } from "vitest";
import { exportOPML, ImportFiles, importNotionItems, MemoryPersistence, parseOPML, plainText, WorkspaceStore, type Block } from "../src/index.js";

const enc = new TextEncoder();
const store = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
const kids = (s: WorkspaceStore, parent: string): Block[] => s.children(parent).map((id) => s.blocks.get(id)!);

const WORKFLOWY = `<?xml version="1.0"?>
<opml version="2.0">
  <head><title>Plans &amp; ideas</title></head>
  <body>
    <outline text="Trip" _note="Book before May">
      <outline text="Flights" _complete="true" />
      <outline text="&lt;b&gt;Hotels&lt;/b&gt;">
        <outline text="Alfama" />
      </outline>
    </outline>
    <outline text="Read" url="https://example.com/article" />
  </body>
</opml>`;

describe("OPML", () => {
  it("lesen: Titel, Verschachtelung, Notiz, erledigt, Link; Feeds; kein OPML", () => {
    const r = parseOPML(WORKFLOWY);
    expect(r.title).toBe("Plans & ideas");
    expect(r.outlines.map((o) => o.text)).toEqual(["Trip", "Read"]);
    expect(r.outlines[0]!.note).toBe("Book before May");
    expect(r.outlines[0]!.children.map((o) => [o.text, o.complete])).toEqual([["Flights", true], ["<b>Hotels</b>", false]]);
    expect(r.outlines[0]!.children[1]!.children[0]!.text).toBe("Alfama");
    const feeds = parseOPML('<opml><body><outline text="Tech"><outline type="rss" text="Blog" xmlUrl="https://b.example/feed" htmlUrl="https://b.example"/></outline></body></opml>');
    expect(feeds.outlines[0]!.children[0]!.url).toBe("https://b.example");
    expect(() => parseOPML("<html></html>")).toThrow("Not an OPML");
  });

  it("Import als Seite mit Liste; Rundreise über den Export", () => {
    const s = store();
    const r = importNotionItems(s, [{ files: new ImportFiles([["plans.opml", enc.encode(WORKFLOWY)]]), path: "plans.opml" }]);
    const page = s.blocks.get(r.rootIDs[0]!)!;
    expect(plainText(page.text)).toBe("Plans & ideas");
    const top = kids(s, "b:" + page.id);
    expect(top.map((b) => [b.type, plainText(b.text)])).toEqual([["bulletedList", "Trip"], ["bulletedList", "Read"]]);
    const trip = kids(s, "b:" + top[0]!.id);
    expect(trip.map((b) => [b.type, plainText(b.text), b.props?.checked ?? false])).toEqual([["text", "Book before May", false], ["todo", "Flights", true], ["bulletedList", "Hotels", false]]);
    expect(JSON.stringify(top[1]!.text)).toContain("https://example.com/article");

    const out = exportOPML(s, page.id);
    expect(out.name).toBe("Plans & ideas.opml");
    expect(out.xml).toContain("<title>Plans &amp; ideas</title>");
    expect(out.xml).toContain('<outline text="Flights" _complete="true"/>');
    expect(out.xml).toContain('url="https://example.com/article"');
    const again = parseOPML(out.xml);
    expect(again.outlines.map((o) => o.text)).toEqual(["Trip", "Read"]);
    expect(again.outlines[0]!.children.map((o) => o.text)).toEqual(["Book before May", "Flights", "Hotels"]);
    expect(again.outlines[0]!.children[2]!.children[0]!.text).toBe("Alfama");
  });
});
