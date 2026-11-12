// BSD-260 Teil 8: Logseq-Graph importieren – Seiten-Properties als Frontmatter (alias zählt für Links), id::/collapsed::
// weg, ((Block-Verweise)) als Text, Namensräume und Journal-Titel, logseq/ und .recycle übersprungen.
import { describe, expect, it } from "vitest";
import {
  findObsidianVault, ImportFiles, importNotionItems, isLogseqGraph, logseqBlockIDs, logseqTitle, logseqToMarkdown, MemoryPersistence, plainText, WorkspaceStore, type Block,
} from "../src/index.js";

const enc = new TextEncoder();
const files = (map: Record<string, string>) => new ImportFiles(Object.entries(map).map(([k, v]) => [k, enc.encode(v)] as const));
const UUID = "6573f1f2-1a2b-4c3d-8e9f-0123456789ab";

const GRAPH: Record<string, string> = {
  "graph/logseq/config.edn": "{:meta/version 1}",
  "graph/logseq/bak/pages/old.md": "backup",
  "graph/.recycle/gone.md": "deleted",
  "graph/pages/Project___Alpha.md": ["alias:: PA, [[Alpha]]", "tags:: work", "", "- First idea", "  id:: " + UUID, "  collapsed:: true", "\t- nested point", "- See [[Beta]]"].join("\n"),
  "graph/pages/Beta.md": ["- Refers to ((" + UUID + "))", "- Link via alias [[PA]] and namespace [[Project/Alpha]]", "-"].join("\n"),
  "graph/journals/2026_11_12.md": ["- Met with [[Beta]] team", "- TODO write plan"].join("\n"),
};

describe("Logseq-Graph (BSD-260 Teil 8)", () => {
  it("Hilfen: Erkennen, Titel, Übersetzung", () => {
    expect(isLogseqGraph(files(GRAPH), "graph")).toBe(true);
    expect(findObsidianVault(files({ "g/pages/a.md": "- x", "g/journals/2026_01_01.md": "- y" }), "g")).toBe("g"); // ohne [[Links]]
    expect(findObsidianVault(files({ "z/notes/logseq/config.edn": "{}", "z/notes/pages/a.md": "- [[b]]" }), "")).toBe("z/notes"); // im ZIP eine Ebene tiefer
    expect(logseqTitle("pages/Project___Alpha.md")).toBe("Project/Alpha");
    expect(logseqTitle("pages/A%2FB.md")).toBe("A/B");
    expect(logseqTitle("journals/2026_11_12.md")).toBe("Nov 12th, 2026");
    expect(logseqTitle("journals/2026_01_01.md")).toBe("Jan 1st, 2026");
    expect(logseqTitle("journals/2026_01_22.md")).toBe("Jan 22nd, 2026");
    expect(logseqTitle("journals/2026_01_13.md")).toBe("Jan 13th, 2026");
    const blocks = logseqBlockIDs(GRAPH["graph/pages/Project___Alpha.md"]!);
    expect(blocks.get(UUID)).toBe("First idea");
    const md = logseqToMarkdown(GRAPH["graph/pages/Project___Alpha.md"]!, blocks);
    expect(md.startsWith("---\naliases: [PA, Alpha]\ntags: [work]\n---\n")).toBe(true);
    expect(md).not.toContain("id::");
    expect(md).not.toContain("collapsed::");
    expect(logseqToMarkdown("- Refers to ((" + UUID + "))", blocks)).toBe("- Refers to First idea");
    expect(logseqToMarkdown("- unknown ((00000000-0000-0000-0000-000000000000))")).toBe("- unknown ");
  });

  it("Import: Seiten, Journale, Links über Alias und Namensraum, Block-Verweis als Text, logseq/ übersprungen", () => {
    const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
    const r = importNotionItems(s, [{ files: files(GRAPH), path: "graph" }]);
    expect(r.pages).toBeGreaterThanOrEqual(5);
    const pages = [...s.blocks.values()].filter((b) => b.type === "page").map((b) => plainText(b.text));
    expect(pages).toEqual(expect.arrayContaining(["Pages", "Journals", "Project/Alpha", "Beta", "Nov 12th, 2026"]));
    expect(pages).not.toContain("old");
    expect(pages).not.toContain("gone");
    expect(pages).not.toContain("logseq");
    const page = (t: string) => [...s.blocks.values()].find((b) => b.type === "page" && plainText(b.text) === t)!;
    const textIn = (p: Block) => {
      const out: string[] = [];
      const walk = (id: string) => { for (const c of s.children("b:" + id)) { const b = s.blocks.get(c)!; out.push(JSON.stringify(b.text ?? "")); walk(c); } };
      walk(p.id);
      return out.join("\n");
    };
    const alpha = page("Project/Alpha"), beta = page("Beta");
    const betaText = textIn(beta);
    expect(betaText).toContain("Refers to First idea");
    // [[PA]] (Alias) und [[Project/Alpha]] (Namensraum) werden Erwähnungen derselben Seite
    expect(betaText.split(alpha.id).length - 1).toBe(2);
    expect(textIn(alpha)).not.toContain("collapsed");
    expect(textIn(page("Nov 12th, 2026"))).toContain(beta.id);
  });
});
