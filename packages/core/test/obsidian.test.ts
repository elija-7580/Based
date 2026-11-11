// BSD-260 Teil 1: Obsidian-Vault importieren – Ordner/Folder Notes, Wikilinks (Alias, Überschrift, Pfad, Aliases aus
// dem Frontmatter, gleicher Ordner vor kürzestem Pfad), Einbettungen (Bild, PDF, Audio, Notiz), Frontmatter als
// yaml-Codeblock, Kommentare, Block-IDs, Code bleibt unberührt, ZIP mit Vault, .obsidian/.trash/Canvas übersprungen.
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  findObsidianVault, ImportFiles, importNotionItems, MemoryAssetSink, MemoryPersistence, parseWikiTarget, plainText, splitFrontmatter, WorkspaceStore, yamlList,
  type Block,
} from "../src/index.js";

const enc = new TextEncoder();
const store = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });

const VAULT: Record<string, string> = {
  "My Vault/.obsidian/app.json": "{}",
  "My Vault/.trash/old.md": "deleted",
  "My Vault/Home.md": [
    "---", "aliases: [Start, Index]", "tags:", "  - home", "---",
    "# Home", "",
    "Links: [[Projects/Alpha]], [[Alpha|the alpha]], [[Beta#Plan]], [[Missing note]] and [Std](Projects/Beta.md).",
    "",
    "![[diagram.png]]",
    "",
    "![[spec.pdf]]",
    "",
    "![[voice.m4a]]",
    "",
    "Secret %%hidden comment%% visible. ^abc123",
    "",
    "%%",
    "multi line comment",
    "%%",
    "",
    "```",
    "[[Not a link]] %%keep%%",
    "```",
    "",
    "`[[inline code]]`",
    "",
    "> [!tip] Remember",
    "> Water the plants",
  ].join("\n"),
  "My Vault/Projects/Projects.md": "Folder note for projects.",
  "My Vault/Projects/Alpha.md": "Back to [[Start]].",
  "My Vault/Projects/Beta.md": "## Plan\n\nSee [[Alpha]].",
  "My Vault/Archive/Alpha.md": "Old alpha — links resolve to the nearer one.",
  "My Vault/attachments/diagram.png": "PNG",
  "My Vault/attachments/spec.pdf": "%PDF",
  "My Vault/attachments/voice.m4a": "AUDIO",
  "My Vault/Board.canvas": "{}",
};

function files(map: Record<string, string>) {
  return new ImportFiles(Object.entries(map).map(([k, v]) => [k, enc.encode(v)] as const));
}

function tree(s: WorkspaceStore, parent: string): Block[] {
  return s.children(parent).map((id) => s.blocks.get(id)!).filter(Boolean);
}
const pageNamed = (s: WorkspaceStore, title: string) => [...s.blocks.values()].find((b) => b.type === "page" && plainText(b.text) === title)!;

describe("Obsidian-Vault", () => {
  it("Hilfen: Vault finden, Frontmatter, Listen, Wikilink-Ziele", () => {
    expect(findObsidianVault(files(VAULT), "")).toBe("My Vault");
    expect(findObsidianVault(files({ "a.md": "x" }), "")).toBeUndefined();
    expect(findObsidianVault(files({ "V/a.md": "see [[b]]", "V/b.md": "x" }), "V")).toBe("V"); // ohne .obsidian (Ordner-Wahl im Browser)
    expect(findObsidianVault(files({ "E/a.md": "see [[b]]", "E/a.html": "<p>" }), "E")).toBeUndefined(); // Notion-HTML-Export
    expect(splitFrontmatter("---\na: 1\n---\nbody")).toEqual({ yaml: "a: 1", body: "body" });
    expect(splitFrontmatter("--- not\nbody").yaml).toBeUndefined();
    expect(yamlList("aliases: [A, \"B\"]", "aliases")).toEqual(["A", "B"]);
    expect(yamlList("aliases:\n  - X\n  - 'Y'\nother: 1", "aliases")).toEqual(["X", "Y"]);
    expect(yamlList("alias: Solo", "alias")).toEqual(["Solo"]);
    expect(parseWikiTarget("Folder/Note#Head|Shown")).toEqual({ target: "Folder/Note", alias: "Shown", heading: "Head" });
    expect(parseWikiTarget("Note#^block")).toEqual({ target: "Note", alias: undefined, heading: "block" });
  });

  it("Ordner, Folder Notes, Wikilinks, Einbettungen, Frontmatter, Kommentare", () => {
    const s = store();
    const assets = new MemoryAssetSink();
    const r = importNotionItems(s, [{ files: files(VAULT), path: "My Vault" }], { assets });
    expect(r.rootIDs).toHaveLength(1);
    const root = s.blocks.get(r.rootIDs[0]!)!;
    expect(plainText(root.text)).toBe("My Vault");
    // Ordner zuerst (Archive, Projects – ohne reinen Anhang-Ordner), dann Notizen; .obsidian/.trash fehlen
    expect(tree(s, "b:" + root.id).map((b) => plainText(b.text))).toEqual(["Archive", "Projects", "Home"]);
    expect(r.warnings.some((w) => w.includes("Board.canvas"))).toBe(true);
    expect(r.warnings[0]).toContain("5 notes");

    const projects = pageNamed(s, "Projects");
    const pKids = tree(s, "b:" + projects.id);
    expect(plainText(pKids[0]!.text)).toBe("Folder note for projects."); // Folder Note: Inhalt zuerst
    expect(pKids.slice(1).map((b) => plainText(b.text))).toEqual(["Alpha", "Beta"]);

    const home = pageNamed(s, "Home");
    const kids = tree(s, "b:" + home.id);
    // Frontmatter oben als yaml-Codeblock; doppelte „# Home“-Zeile fällt weg
    expect(kids[0]).toMatchObject({ type: "code", props: { language: "yaml" } });
    expect(plainText(kids[0]!.text)).toContain("aliases: [Start, Index]");
    expect(kids.some((b) => b.type === "heading1")).toBe(false);

    const links = kids[1]!;
    const json = JSON.stringify(links.text);
    const alphaID = tree(s, "b:" + projects.id).find((b) => plainText(b.text) === "Alpha")!.id;
    const betaID = tree(s, "b:" + projects.id).find((b) => plainText(b.text) === "Beta")!.id;
    expect(json).toContain(alphaID);
    expect(json).toContain(betaID);
    expect(plainText(links.text)).toContain("Missing note"); // unaufgelöst: Text bleibt
    expect(plainText(links.text)).not.toContain("[[");

    const types = kids.map((b) => b.type);
    expect(types).toContain("image");
    expect(types).toContain("pdf");
    expect(types).toContain("audio");
    expect(kids.find((b) => b.type === "image")!.props?.asset?.name).toBe("diagram.png");
    expect(r.assets).toBe(3);

    const text = kids.map((b) => plainText(b.text)).join("\n");
    expect(text).toContain("Secret  visible.");
    expect(text).not.toContain("hidden comment");
    expect(text).not.toContain("multi line comment");
    expect(text).not.toContain("^abc123");
    // Code bleibt, wie er ist
    expect(kids.find((b) => b.type === "code" && plainText(b.text).includes("Not a link"))!.text).toBeDefined();
    expect(plainText(kids.find((b) => b.type === "code" && plainText(b.text).includes("Not a link"))!.text)).toBe("[[Not a link]] %%keep%%");
    expect(text).toContain("[[inline code]]");
    expect(kids.some((b) => b.type === "callout")).toBe(true);

    // [[Start]] ist ein Alias von Home; „Alpha“ im Ordner Projects löst zur nahen Notiz auf, nicht zu Archive/Alpha
    const alpha = s.blocks.get(alphaID)!;
    expect(JSON.stringify(tree(s, "b:" + alpha.id)[0]!.text)).toContain(home.id);
    const beta = s.blocks.get(betaID)!;
    expect(JSON.stringify(tree(s, "b:" + beta.id).map((b) => b.text))).toContain(alphaID);
  });

  it("ZIP mit Vault; Titel aus dem Ordner bzw. dem ZIP-Namen", () => {
    const zip = zipSync(Object.fromEntries(Object.entries(VAULT).map(([k, v]) => [k, enc.encode(v)])));
    const s = store();
    const r = importNotionItems(s, [{ files: new ImportFiles([["vault.zip", zip]]), path: "vault.zip" }]);
    expect(plainText(s.blocks.get(r.rootIDs[0]!)!.text)).toBe("My Vault");
    const flat = zipSync({ ".obsidian/app.json": enc.encode("{}"), "Note.md": enc.encode("Hi [[Other]]"), "Other.md": enc.encode("Yo") });
    const s2 = store();
    const r2 = importNotionItems(s2, [{ files: new ImportFiles([["Notes.zip", flat]]), path: "Notes.zip" }]);
    expect(plainText(s2.blocks.get(r2.rootIDs[0]!)!.text)).toBe("Notes");
    expect(tree(s2, "b:" + r2.rootIDs[0]!).map((b) => plainText(b.text))).toEqual(["Note", "Other"]);
  });

  it("neben einem normalen Markdown-Import: beide Wurzeln in Reihenfolge", () => {
    const f = files({ ...VAULT, "loose.md": "# Loose\n\ntext" });
    const s = store();
    const r = importNotionItems(s, [{ files: f, path: "loose.md" }, { files: f, path: "My Vault" }]);
    expect(tree(s, "w").map((b) => plainText(b.text))).toEqual(["Loose", "My Vault"]);
    expect(r.rootIDs).toHaveLength(2);
  });
});
