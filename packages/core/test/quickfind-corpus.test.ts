// BSD-425: Quick Find „findet zu wenig“. Testkorpus mit 20 Suchanfragen und den erwarteten Treffern (Top 3) für die
// erweiterte Suche (`extended`, so ruft Quick Find); ohne `extended` bleibt die Suche wie Swift (fixtures/search).
import { describe, expect, it } from "vitest";
import { MemoryPersistence, nearWord, SearchIndex, WorkspaceStore } from "../src/index.js";
import type { Block, Database, WireRecord } from "../src/index.js";

const T = 1000;
const page = (id: string, text: string, parent = "w", sk = "a0"): Block => ({ id, type: "page", parent, sk, text, createdAt: 0, updatedAt: T });
const block = (id: string, text: string, parent: string, sk = "a0", type = "text", props?: Block["props"]): Block =>
  ({ id, type, parent: "b:" + parent, sk, text, createdAt: 0, updatedAt: T, ...(props ? { props } : {}) });
const stamp = { millis: 1, counter: 0, node: "t" };

function corpus(): WorkspaceStore {
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t", now: () => T });
  const db: Database = {
    id: "db1", blockID: "tasks", title: "Tasks", createdAt: 0, updatedAt: T, stamp,
    properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "st", name: "Status", type: "status", options: [{ id: "o-done", name: "Done", color: "green" }, { id: "o-wait", name: "Waiting for review", color: "yellow" }] },
      { id: "tags", name: "Tags", type: "multiSelect", options: [{ id: "t-fin", name: "Finance", color: "blue" }, { id: "t-urgent", name: "Urgent", color: "red" }] },
      { id: "amt", name: "Amount", type: "number" },
      { id: "note", name: "Note", type: "text" },
    ],
  };
  const records: WireRecord[] = [
    { kind: "block", data: page("trip", "Trip to Lisbon") },
    { kind: "block", data: block("trip-1", "Book the hotel near Alfama", "trip") },
    { kind: "block", data: block("trip-2", "Flights via Frankfurt", "trip", "a1") },
    { kind: "block", data: page("meet", "Weekly meeting notes", "w", "a1") },
    { kind: "block", data: block("meet-1", "Budget discussion with Anna", "meet") },
    { kind: "block", data: block("meet-2", "Next steps: hiring plan", "meet", "a1") },
    { kind: "block", data: page("recipes", "Recipes", "w", "a2") },
    { kind: "block", data: block("rec-1", "Grandma's apple strudel", "recipes") },
    { kind: "block", data: block("rec-file", "", "recipes", "a1", "file", { asset: { id: "as1", name: "Strudel-Rezept-Oma.pdf" } }) },
    { kind: "block", data: block("rec-link", "", "recipes", "a2", "bookmark", { url: "https://example.org/kaiserschmarrn" }) },
    { kind: "block", data: page("strategy", "Product strategy 2027", "w", "a3") },
    { kind: "block", data: block("str-1", "Pricing tiers and packaging", "strategy") },
    { kind: "block", data: block("str-toggle", "Competitors", "strategy", "a1", "toggle") },
    { kind: "block", data: block("str-hidden", "Notion and Obsidian compared", "str-toggle") },
    { kind: "block", data: page("strasse", "Umzug Straße", "w", "a4") },
    { kind: "block", data: block("str-de", "Übergabe der Schlüssel am Freitag", "strasse") },
    { kind: "block", data: { id: "tasks", type: "databasePage", parent: "w", sk: "a5", props: { databaseID: "db1" }, createdAt: 0, updatedAt: T } },
    { kind: "block", data: { id: "row-1", type: "page", parent: "d:db1", sk: "a0", text: "Quarterly taxes", values: { st: { status: { _0: "o-wait" } }, tags: { multiSelect: { _0: ["t-fin", "t-urgent"] } }, amt: { number: { _0: 1234.5 } } }, createdAt: 0, updatedAt: T } },
    { kind: "block", data: { id: "row-2", type: "page", parent: "d:db1", sk: "a1", text: "Renew passport", values: { st: { status: { _0: "o-done" } }, note: { text: { _0: "Appointment at the embassy" } } }, createdAt: 0, updatedAt: T } },
    { kind: "block", data: page("projects", "Projects", "w", "a6") },
    { kind: "block", data: page("onboarding", "Onboarding checklist", "w", "a7") },
    { kind: "block", data: block("onb-1", "Laptop, accounts, buddy", "onboarding") },
  ];
  s.transact("init", (tx) => {
    tx.put({ kind: "database", data: db });
    for (const r of records) tx.put(r);
  });
  return s;
}

const CASES: [query: string, top3: string[]][] = [
  ["lisbon", ["trip"]],
  ["hotel alfama", ["trip"]],
  ["lisbon hotel", ["trip"]], // Titel + Inhalt verteilt
  ["frankfurt hotel", ["trip"]], // zwei Blöcke derselben Seite
  ["meeting budget", ["meet"]],
  ["meetings", ["meet"]], // Plural
  ["metting", ["meet"]], // Tippfehler
  ["anna hiring", ["meet"]],
  ["strudel", ["recipes"]],
  ["rezept oma", ["recipes"]], // Dateiname
  ["kaiserschmarrn", ["recipes"]], // Link
  ["obsidian", ["strategy"]], // im eingeklappten Toggle
  ["strategy pricing", ["strategy"]],
  ["strasse", ["strasse"]], // ß
  ["schlussel freitag", ["strasse"]], // Umlaute
  ["waiting for review", ["row-1"]], // Status-Option
  ["finance urgent", ["row-1"]], // Mehrfachauswahl
  ["taxes finance", ["row-1"]], // Zeilentitel + Option
  ["1234.5", ["row-1"]], // Zahl
  ["embassy passport", ["row-2"]], // Zeilentitel + Text
  ["projcts", ["projects"]], // Tippfehler im Titel
  ["onboarding laptop", ["onboarding"]],
];

describe("BSD-425 Quick Find findet mehr", () => {
  const index = SearchIndex.fromSource(corpus());
  for (const [query, expected] of CASES) {
    it(`„${query}“ → ${expected.join(", ")}`, () => {
      const top = (index.run(query, { extended: true, now: T, limit: 30 }) ?? []).slice(0, 3).map((h) => h.pageID);
      for (const id of expected) expect(top).toContain(id);
    });
  }

  it("genaue Treffer bleiben vorn, ohne extended wie bisher", () => {
    const strict = index.run("meeting", { now: T }) ?? [];
    const ext = index.run("meeting", { extended: true, now: T }) ?? [];
    expect(ext.slice(0, strict.length)).toEqual(strict);
    // ohne extended findet die Swift-Suche verteilte Begriffe nicht (Fixtures bleiben gleich)
    expect((index.run("lisbon hotel", { now: T }) ?? []).map((h) => h.pageID)).toEqual([]);
    // Snippet für verteilte Begriffe aus dem passenden Block
    expect(ext.length).toBeGreaterThan(0);
    const spread = (index.run("frankfurt hotel", { extended: true, now: T }) ?? [])[0];
    expect(spread).toMatchObject({ pageID: "trip", blockID: "trip-1" });
    expect(spread?.snippet).toContain("hotel");
  });

  it("Tippfehler-Regel: eine Änderung, kurze Wörter genau", () => {
    expect(nearWord("meeting", "metting")).toBe(true);
    expect(nearWord("meeting", "meetings")).toBe(true);
    expect(nearWord("meeting", "meting")).toBe(true);
    expect(nearWord("meeting", "meetnig")).toBe(true);
    expect(nearWord("meeting", "mating")).toBe(false);
    expect(nearWord("cat", "car")).toBe(false);
  });

  it("Optionsnamen folgen einer Umbenennung in der Datenbank", () => {
    const s = corpus();
    const idx = SearchIndex.fromSource(s);
    const db = structuredClone(s.databases.get("db1")!);
    db.properties[1]!.options![1]!.name = "Blocked by legal";
    db.stamp = { millis: 2, counter: 0, node: "t" };
    idx.apply({ upserts: [{ kind: "database", data: db }], deletions: [] });
    expect((idx.run("blocked legal", { extended: true, now: T }) ?? []).map((h) => h.pageID)).toContain("row-1");
    expect((idx.run("waiting for review", { extended: true, now: T }) ?? []).map((h) => h.pageID)).not.toContain("row-1");
  });
});
