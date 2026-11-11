// BSD-260 Teil 5: Markdown mit YAML-Frontmatter (Obsidian & Co.) und Seite als JSON. Standard-Markdown bleibt
// unverändert (Swift-Fixtures); Frontmatter nur auf Wunsch.
import { describe, expect, it } from "vitest";
import { exportPageJSON, ImportFiles, importNotionItems, MarkdownExporter, MemoryPersistence, planWorkspaceExport, splitFrontmatter, WorkspaceStore, yamlList } from "../src/index.js";

const enc = new TextEncoder();
const store = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });

const ENEX = `<en-export><note><title>Trip: Lisbon</title><created>20230115T093000Z</created><updated>20230116T101500Z</updated>
<tag>travel</tag><tag>2023</tag><note-attributes><source-url>https://example.com/x</source-url></note-attributes>
<content><![CDATA[<en-note><div>Hello <b>world</b></div><ul><li>One</li></ul></en-note>]]></content></note></en-export>`;

function setup() {
  const s = store();
  const r = importNotionItems(s, [{ files: new ImportFiles([["Travel.enex", enc.encode(ENEX)]]), path: "Travel.enex" }]);
  const dbBlock = s.blocks.get(r.rootIDs[0]!)!;
  const db = [...s.databases.values()].find((d) => d.blockID === dbBlock.id)!;
  const row = s.children("d:" + db.id).map((id) => s.blocks.get(id)!)[0]!;
  return { s, dbBlock, row };
}

describe("Export: Frontmatter und JSON", () => {
  it("Markdown mit Frontmatter: Titel, Zeiten, Properties (Liste, Datum, URL); ohne Option wie bisher", () => {
    const { s, row } = setup();
    const plain = new MarkdownExporter(s).export(row.id);
    expect(plain.startsWith("# Trip: Lisbon\n")).toBe(true);
    expect(plain).toContain("Tags: travel, 2023");
    const md = new MarkdownExporter(s, { frontmatter: true }).export(row.id);
    const { yaml, body } = splitFrontmatter(md);
    expect(yaml).toBeDefined();
    expect(yaml).toContain('title: "Trip: Lisbon"');
    expect(yaml).toContain("created: 2023-01-15T09:30:00Z");
    expect(yamlList(yaml!, "Tags")).toEqual(["travel", "2023"]);
    expect(yaml).toContain("Source: \"https://example.com/x\"");
    expect(yaml).toMatch(/Created: 2023-01-15T09:30:00Z/);
    expect(body).toContain("# Trip: Lisbon");
    expect(body).toContain("Hello **world**");
    expect(body).not.toContain("Tags: travel");
    // über den Workspace-Plan
    const plan = planWorkspaceExport(s, [row], "markdown", { frontmatter: true });
    expect(plan.files[0]!.contents.startsWith("---\ntitle:")).toBe(true);
  });

  it("Seite und Datenbank als JSON", () => {
    const { s, dbBlock, row } = setup();
    const page = exportPageJSON(s, row.id);
    expect(page.name).toBe("Trip  Lisbon.json");
    const v = JSON.parse(page.json);
    expect(v).toMatchObject({ format: "based.page", version: 1, id: row.id, title: "Trip: Lisbon", created: "2023-01-15T09:30:00.000Z" });
    expect(v.properties).toMatchObject({ Tags: ["travel", "2023"], Source: "https://example.com/x", Created: { start: "2023-01-15T09:30:00.000Z", includeTime: true } });
    expect(v.blocks[0]).toMatchObject({ type: "text", text: "Hello **world**", plain: "Hello world" });
    expect(v.blocks[1]).toMatchObject({ type: "bulletedList", plain: "One" });
    const db = JSON.parse(exportPageJSON(s, dbBlock.id).json);
    expect(db.rows).toEqual([{ id: row.id, title: "Trip: Lisbon", properties: expect.objectContaining({ Tags: ["travel", "2023"] }) }]);
    expect(() => exportPageJSON(s, "nope")).toThrow();
  });
});
