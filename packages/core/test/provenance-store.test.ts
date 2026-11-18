// BSD-522 Teil 2: Herkunft im Store – withActor, Autor je Block, origin je Seite, Undo, Sync, Alt-Daten, Archiv,
// Notion-Import. Reine Regeln und Kennungen: provenance-model.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  authorID, checkOriginChange, createPage, encodeRecord, ImportFiles, importNotionItems, loadArchive, MemoryPersistence,
  importArchiveRecords, parseRecord, ProvenanceError, setPageOrigin, WorkspaceStore, writeArchivePackage, type Author, type WireRecord,
} from "../src/index.js";

const claude: Author = { kind: "agent", name: "Claude Code", model: "model-x" };
const store = (records: WireRecord[] = []) => new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n" });
const addText = (s: WorkspaceStore, page: string, text: string) =>
  s.transact("Add", (tx) => tx.put({ kind: "block", data: { id: "t-" + text, type: "text", parent: "b:" + page, sk: "a" + text.length, text, createdAt: 0, updatedAt: 0 } }));
const edit = (s: WorkspaceStore, id: string, text: string) => s.transact("Edit", (tx) => tx.update(id, (b) => { b.text = text; }));

describe("BSD-522 Regeln im Store", () => {
  it("Agent legt eine Seite an: origin ai, jeder Block mit Agent-Autor, Autor einmal in der Tabelle", () => {
    const s = store();
    const page = s.withActor(claude, () => createPage(s, { title: "Agent notes" }));
    s.withActor(claude, () => addText(s, page, "hello"));
    expect(s.blocks.get(page)?.origin).toBe("ai");
    expect(s.blocks.get(page)?.author).toBe(authorID(claude));
    expect(s.blocks.get("t-hello")?.author).toBe(authorID(claude));
    expect(s.workspace.authors).toEqual({ [authorID(claude)]: { kind: "agent", name: "Claude Code", model: "model-x" } });
  });

  it("Mensch ändert eine ai-Seite → mixed; sein Block verliert den Agent-Autor; ai-Block daneben bleibt", () => {
    const s = store();
    const page = s.withActor(claude, () => createPage(s, { title: "Draft" }));
    s.withActor(claude, () => { addText(s, page, "one"); addText(s, page, "three"); });
    edit(s, "t-one", "one, edited by me");
    expect(s.blocks.get(page)?.origin).toBe("mixed");
    expect(s.blocks.get("t-one")?.author).toBeUndefined();
    expect(s.blocks.get("t-three")?.author).toBe(authorID(claude));
  });

  it("Agent schreibt in eine Seite des Menschen (oder unbekannte) → mixed, nie ai", () => {
    const s = store();
    const mine = createPage(s, { title: "Mine" });
    expect(s.blocks.get(mine)?.origin).toBeUndefined();
    s.withActor(claude, () => addText(s, mine, "agent line"));
    expect(s.blocks.get(mine)?.origin).toBe("mixed");
    const reviewed = createPage(s, { title: "Checked" });
    setPageOrigin(s, reviewed, "reviewed");
    s.withActor(claude, () => addText(s, reviewed, "more"));
    expect(s.blocks.get(reviewed)?.origin).toBe("mixed");
  });

  it("Mensch legt Seiten an und bearbeitet: kein Feld, keine Autoren-Tabelle (Alt-Daten bleiben unbekannt)", () => {
    const s = store();
    const p = createPage(s, { title: "Plain" });
    addText(s, p, "x");
    edit(s, "t-x", "y");
    expect(s.blocks.get(p)?.origin).toBeUndefined();
    expect(s.blocks.get("t-x")?.author).toBeUndefined();
    expect(s.workspace.authors).toBeUndefined();
  });

  it("Ausdrücklich setzen: Agent nur ai, reviewed nur der Nutzer; Op lehnt ab und ändert nichts", () => {
    const s = store();
    const p = createPage(s, { title: "P" });
    for (const o of ["human", "reviewed", "mixed"]) {
      expect(() => s.withActor(claude, () => setPageOrigin(s, p, o))).toThrow(ProvenanceError);
    }
    expect(s.blocks.get(p)?.origin).toBeUndefined();
    s.withActor(claude, () => setPageOrigin(s, p, "ai"));
    expect(s.blocks.get(p)?.origin).toBe("ai");
    expect(() => checkOriginChange("reviewed", { kind: "guest", name: "Ana" })).toThrow(ProvenanceError);
    expect(() => checkOriginChange("bogus", undefined)).toThrow(ProvenanceError);
    setPageOrigin(s, p, "reviewed");
    expect(s.blocks.get(p)?.origin).toBe("reviewed");
    setPageOrigin(s, p, "human");
    expect(s.blocks.get(p)?.origin).toBe("human");
  });

  it("ein Schritt rückgängig: Agent-Änderung samt Herkunft", () => {
    const s = store();
    const p = createPage(s, { title: "Mine" });
    addText(s, p, "a");
    s.withActor(claude, () => edit(s, "t-a", "agent"));
    expect(s.blocks.get(p)?.origin).toBe("mixed");
    s.undo();
    expect(s.blocks.get(p)?.origin).toBeUndefined();
    expect(s.blocks.get("t-a")?.author).toBeUndefined();
  });

  it("Sync und Importe mit fertigen Stempeln ändern die Herkunft nicht", () => {
    const s = store();
    const p = s.withActor(claude, () => createPage(s, { title: "Agent" }));
    const page = structuredClone(s.blocks.get(p)!);
    page.text = "Renamed elsewhere";
    page.stamp = { millis: Date.now() + 10_000, counter: 0, node: "other" };
    s.transact("Pull", (tx) => tx.put({ kind: "block", data: page }), { keepStamps: true });
    expect(s.blocks.get(p)?.origin).toBe("ai");
    expect(s.blocks.get(p)?.author).toBe(authorID(claude));
  });
});

describe("BSD-522 Datenformat: rein additiv", () => {
  it("alte Records (fixtures/records/corpus.jsonl) lesen sich unverändert und bekommen kein Feld", () => {
    const lines = readFileSync(new URL("../../../fixtures/records/corpus.jsonl", import.meta.url), "utf8").split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(10);
    const records = lines.map((l) => parseRecord(JSON.parse(l)) as WireRecord);
    for (let i = 0; i < lines.length; i++) expect(encodeRecord(records[i]!)).toBe(lines[i]);
    const s = store(records);
    for (const b of s.blocks.values()) {
      expect(b.origin).toBeUndefined();
      expect(b.author).toBeUndefined();
    }
  });

  it("neue Felder überstehen Kodieren, Parsen und das Based-Archiv", () => {
    const s = store();
    const p = s.withActor(claude, () => createPage(s, { title: "Agent" }));
    s.withActor(claude, () => addText(s, p, "kept"));
    const r = parseRecord(JSON.parse(encodeRecord({ kind: "block", data: s.blocks.get(p)! })));
    expect(r.kind === "block" && r.data.origin).toBe("ai");
    const archive = loadArchive(writeArchivePackage(s, () => undefined).zip).read;
    const t = store();
    importArchiveRecords(t, archive);
    expect(t.blocks.get(p)?.origin).toBe("ai");
    expect(t.blocks.get("t-kept")?.author).toBe(authorID(claude));
    expect(t.workspace.authors?.[authorID(claude)]?.name).toBe("Claude Code");
  });

  it("Notion-Import (Markdown/CSV) lässt die Herkunft leer", () => {
    const s = store();
    const files = new ImportFiles([["Trip 0123456789abcdef0123456789abcdef.md", new TextEncoder().encode("# Trip\n\nPack bags\n")]]);
    importNotionItems(s, [{ files, path: "Trip 0123456789abcdef0123456789abcdef.md" }]);
    const pages = [...s.blocks.values()].filter((b) => b.type === "page");
    expect(pages.length).toBeGreaterThan(0);
    for (const b of s.blocks.values()) {
      expect(b.origin).toBeUndefined();
      expect(b.author).toBeUndefined();
    }
  });
});
