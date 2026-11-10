// BSD-159 / BSD-74: Werkzeuge gegen einen In-Memory-Store – lesen, schreiben, atomar (ein Undo-Schritt, alles oder
// nichts), Formatierung bleibt beim Ersetzen.
import { describe, expect, it } from "vitest";
import { addOption, addProperty, createDatabase, createPage, keyOf, plainText, rowsOf, trashPages, type WorkspaceStore } from "@based/core";
import { WorkspaceTools } from "../src/index.js";
import { memoryStore } from "./helpers.js";

function setup() {
  const store = memoryStore();
  const tools = new WorkspaceTools(store);
  const call = (name: string, input: Record<string, unknown> = {}) => tools.callSync(name, input as never);
  const ok = (name: string, input: Record<string, unknown> = {}) => {
    const r = call(name, input);
    expect(r.isError, r.text).toBe(false);
    return r.text;
  };
  const idIn = (text: string) => /\(id: ([^)]+)\)/.exec(text)![1]!;
  return { store, tools, call, ok, idIn };
}

/** Zustand aller Blöcke ohne Stempel/Zeiten (zum Vergleich „nichts geändert“). */
const snapshot = (store: WorkspaceStore) => JSON.stringify([...store.blocks.values()].map((b) => ({ ...b, stamp: undefined, updatedAt: undefined })).sort((a, b) => (a.id < b.id ? -1 : 1)));

const body = (store: WorkspaceStore, page: string) => store.children("b:" + page).map((id) => store.blocks.get(id)!);

describe("WorkspaceTools – Seiten", () => {
  it("create_page aus Markdown, read_page, list_pages, search", () => {
    const { store, ok, idIn } = setup();
    const created = ok("create_page", { markdown: "# Lisbon trip\n\nFlights are **booked**.\n\n- Pack sunscreen\n- Book the tram tour" });
    expect(created).toMatch(/^Created page “Lisbon trip” \(id: /);
    const id = idIn(created);
    expect(plainText(store.blocks.get(id)!.text)).toBe("Lisbon trip");
    expect(body(store, id).map((b) => b.type)).toEqual(["text", "bulletedList", "bulletedList"]);
    expect(body(store, id)[0]!.text).toEqual([{ t: "Flights are " }, { t: "booked", m: { b: true } }, { t: "." }]);
    const md = ok("read_page", { page_id: id });
    expect(md).toContain("Flights are **booked**.");
    expect(md).toContain("- Pack sunscreen");
    const sub = idIn(ok("create_page", { title: "Day 1", markdown: "Alfama walk", parent_id: id }));
    expect(ok("list_pages")).toBe(`- Lisbon trip (id: ${id})`);
    expect(ok("list_pages", { parent_id: id })).toBe(`- Day 1 (id: ${sub})`);
    expect(ok("search", { query: "sunscreen" })).toContain(`- Lisbon trip (id: ${id})`);
    expect(ok("search", { query: "zzzz-nothing" })).toBe("No pages found.");
  });

  it("jedes Schreib-Werkzeug ist genau ein Undo-Schritt", () => {
    const { store, ok, idIn } = setup();
    const before = snapshot(store);
    const id = idIn(ok("create_page", { title: "Plan", markdown: "one\n\ntwo\n\nthree" }));
    expect(store.blocks.size).toBe(4);
    store.undo();
    expect(snapshot(store), "Seite samt Inhalt mit einem Undo weg").toBe(before);
    store.redo();
    expect(body(store, id)).toHaveLength(3);

    const afterCreate = snapshot(store);
    ok("append_markdown", { page_id: id, markdown: "four\n\n- five\n    - nested" });
    expect(body(store, id)).toHaveLength(5);
    store.undo();
    expect(snapshot(store)).toBe(afterCreate);

    ok("replace_page_content", { page_id: id, markdown: "## Fresh\n\nNew text" });
    expect(body(store, id).map((b) => plainText(b.text))).toEqual(["Fresh", "New text"]);
    store.undo();
    expect(snapshot(store), "Löschen + Einfügen sind EIN Schritt: nie eine leere Seite dazwischen").toBe(afterCreate);
    expect(body(store, id).map((b) => plainText(b.text))).toEqual(["one", "two", "three"]);
  });

  it("replace_page_content: eine Transaktion (ein Change, kein leerer Zwischenstand), Unterseiten bleiben", () => {
    const { store, ok, idIn } = setup();
    const id = idIn(ok("create_page", { title: "Doc", markdown: "old a\n\nold b" }));
    const sub = createPage(store, { parent: id, title: "Child" });
    const changes: number[] = [];
    const off = store.observe((c) => {
      changes.push(c.keys.length);
      expect(body(store, id).filter((b) => b.type !== "page").length, "Beobachter sehen nie die leere Seite").toBeGreaterThan(0);
    });
    ok("replace_page_content", { page_id: id, markdown: "new" });
    off();
    expect(changes).toHaveLength(1);
    expect(store.blocks.has(sub)).toBe(true);
    expect(body(store, id).map((b) => plainText(b.text)).sort()).toEqual(["Child", "new"]);
  });

  it("find_replace erhält Fett, Kursiv, Links und Erwähnungen", () => {
    const { store, ok, idIn, call } = setup();
    const other = idIn(ok("create_page", { title: "Roadmap" }));
    const id = idIn(ok("create_page", { title: "Notes", markdown: `Ship the **big plan** by [Friday](https://example.com/cal), see [Roadmap](based://page/${other}).\n\nFriday is *also* the demo.` }));
    const [first, second] = body(store, id);
    const mention = (first!.text as { mention?: unknown }[]).find((r) => r.mention !== undefined);
    expect(mention).toBeDefined();
    const before = snapshot(store);

    expect(ok("find_replace", { page_id: id, find: "Friday", replace: "Monday", all: true })).toBe("Replaced 2 occurrences in “Notes”");
    const [a, b] = body(store, id);
    expect(a!.id).toBe(first!.id);
    expect(a!.text).toEqual([
      { t: "Ship the " }, { t: "big plan", m: { b: true } }, { t: " by " }, { t: "Monday", m: { link: "https://example.com/cal" } }, { t: ", see " }, mention, { t: "." },
    ]);
    expect(b!.text).toEqual([{ t: "Monday is " }, { t: "also", m: { i: true } }, { t: " the demo." }]);
    expect(b!.id).toBe(second!.id);
    store.undo();
    expect(snapshot(store), "alle Blöcke in einem Undo-Schritt zurück").toBe(before);

    // ohne `all`: nur der erste Treffer
    ok("find_replace", { page_id: id, find: "Friday", replace: "Monday" });
    expect(plainText(body(store, id)[1]!.text)).toBe("Friday is also the demo.");
    // nicht gefunden: Fehler, nichts geändert
    const now = snapshot(store);
    const miss = call("find_replace", { page_id: id, find: "Sunday", replace: "x" });
    expect(miss).toEqual({ text: "“Sunday” was not found in “Notes”. Nothing was changed.", isError: true });
    expect(snapshot(store)).toBe(now);
  });

  it("update_page: Titel und Icon in einem Schritt", () => {
    const { store, ok, idIn } = setup();
    const id = idIn(ok("create_page", { title: "Old" }));
    ok("update_page", { page_id: id, title: "New", icon: "🧭" });
    expect(store.blocks.get(id)).toMatchObject({ text: "New", props: { icon: "🧭" } });
    store.undo();
    expect(store.blocks.get(id)).toMatchObject({ text: "Old" });
    expect(store.blocks.get(id)!.props?.icon).toBeUndefined();
  });

  it("Fehler schreiben nichts: unbekannte Seite, Papierkorb, fehlende Argumente, unbekanntes Werkzeug", () => {
    const { store, ok, idIn, call } = setup();
    const id = idIn(ok("create_page", { title: "Gone", markdown: "x" }));
    trashPages(store, [id]);
    const before = snapshot(store);
    const undoable = store.canUndo;
    expect(call("append_markdown", { page_id: id, markdown: "y" })).toEqual({ text: `Page ${id} is in the Trash`, isError: true });
    expect(call("append_markdown", { page_id: "nope", markdown: "y" })).toEqual({ text: "No page with id nope", isError: true });
    expect(call("create_page", { title: "Child", parent_id: "nope" }).isError).toBe(true);
    expect(call("find_replace", { page_id: id }).isError).toBe(true);
    expect(call("update_page", { page_id: id }).isError).toBe(true);
    expect(call("launch_rocket", {})).toEqual({ text: "Unknown tool launch_rocket", isError: true });
    expect(call("read_page", "not an object" as never).text).toBe("Missing argument page_id");
    expect(snapshot(store)).toBe(before);
    expect(store.canUndo).toBe(undoable);
    // lesen geht auch im Papierkorb, mit Hinweis
    expect(ok("read_page", { page_id: id })).toMatch(/^\(in the Trash\)/);
  });

  it("alles oder nichts: scheitert ein Schreiben mittendrin, bleibt der Store unverändert", () => {
    const { store, ok, idIn, call } = setup();
    const id = idIn(ok("create_page", { title: "Doc", markdown: "keep me\n\nand me" }));
    // ein Toggle mit einer Unterseite darin: replace_page_content bricht ab, nachdem es schon Blöcke entfernt hat
    const toggle = body(store, id)[1]!;
    store.transact("nest", (tx) => tx.update(toggle.id, (x) => { x.type = "toggle"; }));
    const nested = createPage(store, { parent: toggle.id, title: "Nested page" });
    const before = snapshot(store);
    const r = call("replace_page_content", { page_id: id, markdown: "replacement" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("sub-pages nested inside its blocks");
    expect(snapshot(store), "der schon entfernte erste Block ist zurück").toBe(before);
    expect(store.blocks.has(nested)).toBe(true);
    expect(store.record(keyOf("block", body(store, id)[0]!.id))).toBeDefined();
  });

  it("schreibgeschützter Store: Schreib-Werkzeuge melden den Fehler, Lesen geht", () => {
    const { store, ok, idIn, call } = setup();
    const id = idIn(ok("create_page", { title: "Doc" }));
    store.writeFailure = { message: "disk full", since: 0, rejected: 0 };
    expect(call("append_markdown", { page_id: id, markdown: "x" })).toEqual({ text: "The workspace is read-only right now (saving failed). Nothing was changed.", isError: true });
    expect(call("read_page", { page_id: id }).isError).toBe(false);
  });

  it("Schreib-Werkzeuge sind als solche markiert (für „Ask before edits“)", () => {
    const { tools } = setup();
    const write = tools.specs.map((s) => s.name).filter((n) => tools.isWrite(n));
    expect(write).toEqual(["create_page", "append_markdown", "replace_page_content", "find_replace", "update_page", "add_row", "update_row"]);
    expect(tools.specs.map((s) => s.name).filter((n) => !tools.isWrite(n))).toEqual(["search", "read_page", "list_pages", "list_databases", "query_database"]);
    expect(tools.isWrite("unknown"), "Unbekanntes gilt als Schreiben").toBe(true);
    for (const s of tools.specs) expect(s.inputSchema).toMatchObject({ type: "object" });
  });
});

describe("WorkspaceTools – Datenbanken", () => {
  function withDatabase() {
    const s = setup();
    const page = createPage(s.store, { title: "Projects" });
    const db = createDatabase(s.store, { parent: "b:" + page, title: "Tasks", sampleRows: 0 }).databaseID;
    const status = addProperty(s.store, db, "Stage", "select")!;
    addOption(s.store, db, status, "Todo");
    addOption(s.store, db, status, "Done");
    addProperty(s.store, db, "Points", "number");
    addProperty(s.store, db, "Urgent", "checkbox");
    addProperty(s.store, db, "Due", "date");
    return { ...s, db };
  }

  it("list_databases zeigt Schema und Optionen", () => {
    const { ok, db } = withDatabase();
    const text = ok("list_databases");
    expect(text).toContain(`- Tasks (id: ${db}, 0 rows)`);
    expect(text).toContain("Stage: select [Todo, Done]");
    expect(text).toContain("Points: number");
  });

  it("add_row setzt Properties über Namen; query_database liest sie als Text", () => {
    const { store, ok, db, idIn } = withDatabase();
    const row = idIn(ok("add_row", { database_id: db, title: "Write tests", properties: { Stage: "Todo", Points: "5", Urgent: "true", Due: "2026-11-12" } }));
    expect(rowsOf(store, db).map((r) => r.id)).toEqual([row]);
    const line = ok("query_database", { database_id: db });
    expect(line).toContain(`- Write tests (id: ${row}) — `);
    expect(line).toContain("Stage: Todo");
    expect(line).toContain("Points: 5");
    store.undo();
    expect(rowsOf(store, db), "Zeile mit allen Werten ist ein Undo-Schritt").toEqual([]);
  });

  it("update_row ändert Titel und Werte in einem Schritt; leerer String leert", () => {
    const { store, ok, db, idIn } = withDatabase();
    const row = idIn(ok("add_row", { database_id: db, title: "A", properties: { Stage: "Todo", Points: "3" } }));
    const before = JSON.stringify(store.blocks.get(row)!.values);
    ok("update_row", { row_id: row, title: "B", properties: { stage: "Done", Points: "" } });
    expect(plainText(store.blocks.get(row)!.text)).toBe("B");
    const line = ok("query_database", { database_id: db });
    expect(line).toContain("Stage: Done");
    expect(line).not.toContain("Points");
    store.undo();
    expect(plainText(store.blocks.get(row)!.text)).toBe("A");
    expect(JSON.stringify(store.blocks.get(row)!.values)).toBe(before);
  });

  it("ungültige Werte: Fehler mit Hinweis, es wird nichts geschrieben (auch keine halbe Zeile)", () => {
    const { store, call, db, ok, idIn } = withDatabase();
    const before = snapshot(store);
    expect(call("add_row", { database_id: db, title: "X", properties: { Stage: "Maybe" } })).toEqual({ text: "Property “Stage” (select): can't read “Maybe”. Options: Todo, Done", isError: true });
    expect(call("add_row", { database_id: db, title: "X", properties: { Nope: "1" } }).text).toContain("No property “Nope” in this database. Properties: ");
    expect(call("add_row", { database_id: db, title: "X", properties: { Points: "many" } }).isError).toBe(true);
    expect(call("add_row", { database_id: "missing" }).isError).toBe(true);
    expect(snapshot(store)).toBe(before);
    const row = idIn(ok("add_row", { database_id: db, title: "Y", properties: { Points: "1" } }));
    const after = snapshot(store);
    expect(call("update_row", { row_id: row, title: "Z", properties: { Points: "2", Stage: "Maybe" } }).isError).toBe(true);
    expect(snapshot(store), "gültige Teile werden nicht vorab geschrieben").toBe(after);
    expect(call("update_row", { row_id: "nope", title: "Z" }).isError).toBe(true);
  });

  it("Listen sind gepaged", () => {
    const { ok, db } = withDatabase();
    for (let i = 0; i < 5; i++) ok("add_row", { database_id: db, title: "Row " + i });
    const text = ok("query_database", { database_id: db, limit: 2, offset: 1 });
    expect(text.split("\n").map((l) => l.replace(/ \(id: [^)]+\)/, ""))).toEqual(["- Row 1", "- Row 2", "… 2 more (offset: 3)"]);
  });
});
