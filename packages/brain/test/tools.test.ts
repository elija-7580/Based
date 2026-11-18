// BSD-159 / BSD-74: Werkzeuge gegen einen In-Memory-Store – lesen, schreiben, atomar (ein Undo-Schritt, alles oder
// nichts), Formatierung bleibt beim Ersetzen.
import { describe, expect, it } from "vitest";
import { addOption, addProperty, createDatabase, createPage, keyOf, makeBlock, plainText, rowsOf, trashPages, type WorkspaceStore } from "@based/core";
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

describe("BSD-522: Werkzeuge schreiben als Agent", () => {
  it("create_page → Herkunft ai und Agent-Autor; Lesen ändert nichts; der Store schreibt danach wieder als Nutzer", () => {
    const { store, ok, idIn } = setup();
    const id = idIn(ok("create_page", { markdown: "# From the tools\n\nFirst line" }));
    expect(store.blocks.get(id)?.origin).toBe("ai");
    const author = store.blocks.get(id)?.author;
    expect(author).toMatch(/^a-/);
    expect(store.workspace.authors?.[author!]?.name).toBe("Based agent");
    ok("read_page", { page_id: id });
    expect(store.actor).toBeUndefined();
    const mine = createPage(store, { title: "Mine" });
    expect(store.blocks.get(mine)?.origin).toBeUndefined();
  });

  it("eigener Autor (Option) und der am Store eingetragene (MCP) gehen vor", () => {
    const store = memoryStore();
    const named = new WorkspaceTools(store, { actor: { kind: "agent", name: "Planner", model: "m1" } });
    const a = /\(id: ([^)]+)\)/.exec(named.callSync("create_page", { title: "A" } as never).text)![1]!;
    expect(store.workspace.authors?.[store.blocks.get(a)!.author!]).toEqual({ kind: "agent", name: "Planner", model: "m1" });
    const plain = new WorkspaceTools(store);
    const b = store.withActor({ kind: "agent", name: "claude-code" }, () => /\(id: ([^)]+)\)/.exec(plain.callSync("create_page", { title: "B" } as never).text)![1]!);
    expect(store.workspace.authors?.[store.blocks.get(b)!.author!]?.name).toBe("claude-code");
  });
});

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
    expect(ok("search", { query: "zzzz-nothing" })).toBe("No matches.");
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
    expect(call("append_markdown", { page_id: id, markdown: "y" })).toEqual({ text: `Page ${id} is in the Trash (restore_page brings it back)`, isError: true });
    expect(call("append_markdown", { page_id: "nope", markdown: "y" })).toEqual({ text: "No page with id nope", isError: true });
    expect(call("create_page", { title: "Child", parent_id: "nope" }).isError).toBe(true);
    expect(call("find_replace", { page_id: id }).isError).toBe(true);
    expect(call("update_page", { page_id: id }).isError).toBe(true);
    expect(call("launch_rocket", {})).toEqual({ text: "Unknown tool launch_rocket", isError: true });
    expect(call("read_page", "not an object" as never).text).toBe("Missing argument id.");
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
    expect(write).toEqual([
      "create_page", "append_markdown", "replace_page_content", "find_replace", "update_page", "move_page", "duplicate_page", "trash_page", "restore_page", "set_favorite",
      "draw_board", "add_row", "update_row", "create_database", "update_database", "create_view", "update_view", "delete_view", "remember",
      "ask_main_agent", "resolve_inbox", "create_project", "update_project_status", "undo_last",
    ]);
    expect(tools.specs.map((s) => s.name).filter((n) => !tools.isWrite(n))).toEqual([
      "based_guide", "search", "read_page", "list_pages", "list_trash", "backlinks", "read_board", "list_files", "list_databases", "database_schema", "query_database", "list_views",
      "recall", "related", "about_me", "list_skills", "load_skill", "list_runs", "get_run", "inbox", "list_projects", "get_project",
    ]);
    // was etwas verwerfen kann, ist als solches markiert
    expect(tools.specs.map((s) => s.name).filter((n) => tools.isDestructive(n))).toEqual(["replace_page_content", "trash_page", "update_database", "delete_view"]);
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
    expect(text).toContain(`- Tasks (id: ${db}) — 0 rows — `);
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
    // eine Auswahl, die es noch nicht gibt, wird angelegt (wie beim Tippen in der Zelle) – ein Status nicht
    expect(call("add_row", { database_id: db, title: "X", properties: { Nope: "1" } }).text).toContain("No property “Nope”. Properties: ");
    expect(call("add_row", { database_id: db, title: "X", properties: { Points: "many" } }).isError).toBe(true);
    expect(call("add_row", { database_id: "missing" }).isError).toBe(true);
    expect(snapshot(store)).toBe(before);
    const row = idIn(ok("add_row", { database_id: db, title: "Y", properties: { Points: "1" } }));
    const after = snapshot(store);
    expect(call("update_row", { row_id: row, title: "Z", properties: { Stage: "Later", Points: "many" } }).isError).toBe(true);
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

// docs/agent-parity.md: eine Werkzeug-Schicht – was für alle Werkzeuge gilt, steht einmal in WorkspaceTools.
describe("Agent-Parität: Regeln für alle Werkzeuge", () => {
  it("Argumente werden vor dem Lauf geprüft; die Meldung sagt, was richtig wäre", () => {
    const { store, call, ok, idIn } = setup();
    const id = idIn(ok("create_page", { title: "Doc" }));
    const before = snapshot(store);
    expect(call("append_markdown", { id, markdown: "x", colour: "red" }).text).toBe("Unknown argument colour. Arguments: id, markdown.");
    expect(call("append_markdown", { id }).text).toBe("Missing argument markdown.");
    expect(call("list_pages", { limit: "many" }).text).toBe("Argument limit must be a number.");
    expect(call("list_pages", { limit: 0 }).text).toBe("Argument limit must be at least 1.");
    expect(call("remember", { fact: "x", type: "Secret" }).text).toBe("Argument type must be one of: Profile, Preference, Work, People, Notes.");
    expect(call("set_favorite", { id, favorite: "maybe" }).text).toBe("Argument favorite must be true or false.");
    expect(snapshot(store)).toBe(before);
    // Was Modelle gern falsch schreiben, wird angenommen: Zahl als Text, Wahrheitswert als Text, null = weggelassen
    expect(call("list_pages", { limit: "5", parent: null }).isError).toBe(false);
    expect(call("set_favorite", { id, favorite: "true" }).isError).toBe(false);
    expect(store.workspace.favorites).toContain(id);
  });

  it("frühere Argumentnamen gehen weiter (page_id, parent_id, database_id, row_id, properties)", () => {
    const { store, ok, idIn } = setup();
    const a = idIn(ok("create_page", { title: "A" }));
    const b = idIn(ok("create_page", { title: "B", parent_id: a }));
    expect(store.blocks.get(b)?.parent).toBe("b:" + a);
    expect(ok("read_page", { page_id: b })).toBe(ok("read_page", { id: b }));
    expect(ok("list_pages", { parent_id: a })).toBe(ok("list_pages", { parent: a }));
  });

  it("ein Werkzeug, das intern mehrere Schritte macht, ist trotzdem EIN Undo-Schritt und ein Change", () => {
    const { store, ok, idIn } = setup();
    const made = ok("create_database", { title: "Tasks", properties: { Stage: "select", Points: "number", Due: "date" } });
    const db = /Created database (\S+)/.exec(made)![1]!;
    const changes: string[] = [];
    const off = store.observe((c) => changes.push(c.name ?? ""));
    // neue Auswahl-Option + Zeile + drei Werte: im Kern fünf Transaktionen
    const row = idIn(ok("add_row", { id: db, values: { Name: "Ship", Stage: "Doing", Points: "3", Due: "2026-11-20" } }));
    off();
    expect(changes).toEqual(["Agent: add row"]);
    expect(ok("query_database", { id: db })).toBe(`- Ship (id: ${row}) — Stage: Doing; Points: 3; Due: 2026-11-20`);
    store.undo();
    expect(rowsOf(store, db)).toEqual([]);
    expect(store.databases.get(db)!.properties.find((p) => p.name === "Stage")!.options ?? [], "auch die neue Option ist wieder weg").toEqual([]);
    // create_database selbst (Datenbank, Ansicht, drei Properties) war auch einer
    store.undo();
    expect(store.databases.has(db)).toBe(false);
  });

  it("alles oder nichts über mehrere Schritte: scheitert der dritte, sind die ersten beiden nicht geschrieben", () => {
    const { store, ok, call } = setup();
    const db = /Created database (\S+)/.exec(ok("create_database", { title: "T", properties: { Points: "number" } }))![1]!;
    const before = snapshot(store);
    const dbBefore = JSON.stringify(store.databases.get(db));
    const r = call("add_row", { id: db, values: { Name: "X", Tag: "new" } });
    expect(r.isError).toBe(true);
    const u = call("update_database", { database_id: db, title: "Renamed", add_properties: { Stage: "select" }, delete_properties: ["Nope"] });
    expect(u.isError).toBe(true);
    expect(snapshot(store)).toBe(before);
    expect(JSON.stringify(store.databases.get(db))).toBe(dbBefore);
  });

  it("wirft ein Werkzeug, nachdem Kern-Funktionen schon geschrieben haben, ist nichts davon im Store (auch kein Undo-Schritt)", () => {
    const store = memoryStore();
    const tools = new WorkspaceTools(store, {
      extra: () => [{
        group: "pages", write: true,
        spec: { name: "half_done", description: "Writes two pages with core functions, then fails.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false } },
        run: () => {
          createPage(store, { title: "One" });
          createPage(store, { title: "Two" });
          throw new Error("third step failed");
        },
      }],
    });
    const changes: number[] = [];
    store.observe((c) => changes.push(c.keys.length));
    expect(tools.callSync("half_done", {})).toEqual({ text: "Tool half_done failed: third step failed", isError: true });
    expect(store.blocks.size).toBe(0);
    expect(store.canUndo).toBe(false);
    expect(changes, "kein Beobachter (Sync, Suche) hat den halben Stand gesehen").toEqual([]);
  });

  it("undo_last nimmt genau den letzten eigenen Aufruf zurück – auch wenn der Mensch danach weitergeschrieben hat", () => {
    const { store, ok, call, idIn } = setup();
    expect(call("undo_last").text).toBe("There is nothing of yours to undo here.");
    const id = idIn(ok("create_page", { title: "Doc", markdown: "keep" }));
    ok("append_markdown", { id, markdown: "agent line" });
    const mine = createPage(store, { title: "Typed by the user" });
    expect(ok("undo_last")).toBe("Undid append_markdown (1 record restored).");
    expect(body(store, id).map((b) => plainText(b.text))).toEqual(["keep"]);
    expect(store.blocks.has(mine), "die Seite des Nutzers bleibt").toBe(true);
    // nur der letzte Aufruf, nicht der davor
    expect(call("undo_last").isError).toBe(true);
    expect(store.blocks.has(id)).toBe(true);
    // hat der Mensch dieselbe Stelle inzwischen geändert, bleibt seine Fassung
    ok("update_page", { id, title: "From the agent" });
    store.transact("user", (tx) => tx.update(id, (x) => { x.text = "From the user"; }));
    expect(call("undo_last")).toEqual({ text: "Your last change (update_page) was not undone: everything it touched has been edited since.", isError: true });
    expect(plainText(store.blocks.get(id)!.text)).toBe("From the user");
  });

  it("undo_last gilt je Agent: keiner nimmt den Schritt eines anderen zurück", () => {
    const store = memoryStore();
    const tools = new WorkspaceTools(store);
    const as = (name: string) => ({ kind: "agent" as const, name });
    const a = /\(id: ([^)]+)\)/.exec(tools.callSync("create_page", { title: "By A" }, as("A")).text)![1]!;
    expect(tools.callSync("undo_last", {}, as("B")).isError).toBe(true);
    expect(store.blocks.has(a)).toBe(true);
    expect(tools.callSync("undo_last", {}, as("A")).isError).toBe(false);
    expect(store.blocks.has(a)).toBe(false);
  });

  it("Bereiche: ein Host bietet nur an, was er braucht; wartende Werkzeuge laufen über call()", async () => {
    const store = memoryStore();
    const few = new WorkspaceTools(store, { groups: ["pages"] });
    expect(few.specs.map((s) => s.name)).not.toContain("query_database");
    expect(few.callSync("query_database", { id: "x" })).toEqual({ text: "Unknown tool query_database", isError: true });
    const all = new WorkspaceTools(store);
    createPage(store, { title: "Zebra finch notes" });
    expect(all.callSync("recall", { query: "zebra" }).text).toContain("call()");
    const r = await all.call("recall", { query: "zebra finch" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain("Zebra finch notes");
    all.dispose();
    few.dispose();
  });

  it("jedes Werkzeug hat Bereich, Beschreibung und ein geschlossenes Schema", () => {
    const { tools } = setup();
    expect(new Set(tools.all.map((d) => d.spec.name)).size).toBe(tools.all.length);
    for (const d of tools.all) {
      expect(d.spec.description.length, d.spec.name).toBeGreaterThan(20);
      expect(d.spec.inputSchema, d.spec.name).toMatchObject({ type: "object", additionalProperties: false });
      // jeder frühere Name zeigt auf ein Argument, das es gibt
      const props = Object.keys((d.spec.inputSchema as { properties: object }).properties);
      for (const now of Object.values(d.aliases ?? {})) expect(props, d.spec.name).toContain(now);
    }
  });
});

// BSD-93: Agenten bedienen Whiteboards über Text (read_board, draw_board).
describe("Whiteboard für Agenten", () => {
  it("draw_board legt ein Board an, ordnet an, verknüpft eine Seite; read_board liest es knapp zurück", () => {
    const { store, ok, idIn } = setup();
    const page = createPage(store, { title: "Lecture 5" });
    const out = ok("draw_board", { title: "Regression map", script: `page p: ${page}\nnote n: Residual plots are on the exam\nbox b: Least squares\np -> n: explains\nn -> b\nframe f: Exam { n b }` });
    const board = idIn(out);
    expect(out).toContain("6 added");
    expect(out).toMatch(/Handles: p=\w+ n=\w+ b=\w+ f=\w+/);
    const text = ok("read_board", { page_id: board });
    expect(text).toContain(`page ${page} "Lecture 5"`);
    expect(text).toContain('note "Residual plots are on the exam"');
    expect(text).toMatch(/\w+ -> \w+: explains/);
    expect(text.length).toBeLessThan(420); // knapp: das ganze Board in rund hundert Token
    expect(store.children("b:" + board)).toHaveLength(6);
  });
  it("ändern und löschen über Kennungen; unbekannte Seite und Unverständliches werden gemeldet, der Rest gilt", () => {
    const { store, ok, idIn } = setup();
    const out = ok("draw_board", { script: "note a: one\nnote b: two\na -> b" });
    const board = idIn(out);
    const [, a, b] = /Handles: a=(\w+) b=(\w+)/.exec(out)!;
    const second = ok("draw_board", { page_id: board, script: `set ${a}: renamed\ndel ${b}\npage x: nope\nwhatever` });
    expect(second).toContain("0 added, 1 changed, 2 removed");
    expect(second).toContain("no such page");
    expect(second).toContain("not understood");
    expect(ok("read_board", { page_id: board })).toBe(`${a} note "renamed" @0,0 168x150 {agent}`);
    expect(store.children("b:" + board)).toHaveLength(1);
  });
  it("Elija 18.11.: Dateien aus dem Workspace wählen und aufs Board legen; Farben, Zeichnen, Hintergrund", () => {
    const store = memoryStore();
    const hash = "d".repeat(64);
    const page = createPage(store, { title: "Trip" });
    store.transact("img", (tx) => tx.put({ kind: "block", data: makeBlock({ id: "img-1", type: "image", parent: "b:" + page, sk: "a0", props: { asset: { id: hash, name: "beach.jpg" } } }, store.now()) }));
    // Der Host kennt die Bytes: Maße kommen dazu.
    const tools = new WorkspaceTools(store, { fileInfo: (ref) => (ref.endsWith(hash) ? { mime: "image/jpeg", width: 1200, height: 800, size: 2048 } : undefined) });
    const run = (name: string, input: Record<string, unknown>) => { const r = tools.callSync(name, input as never); expect(r.isError, r.text).toBe(false); return r.text; };
    expect(run("list_files", {})).toBe(`based-asset:${hash} "beach.jpg" 1200x800 2 KB`);
    expect(run("list_files", { query: "nope" })).toContain("No file matches");
    const out = run("draw_board", { script: `image i: based-asset:${hash} {at=0,0}\nnote n: Look! {color=green}\nink s: M0 0 C 20 -20 40 20 60 0 {color=red at=0,300}\nbackground lines` });
    expect(out).toContain("background lines");
    const board = /\(id: ([^)]+)\)/.exec(out)![1]!;
    const read = run("read_board", { page_id: board });
    expect(read).toContain('image "beach.jpg"');
    expect(read).toContain("@0,0 480x320");
    expect(read).toMatch(/note "Look!" .*\{color=green agent\}/);
    expect(read).toMatch(/ink @-?\d+,29\d \d+x\d+ \{color=red agent\}/);
    expect(read.split("\n")[0]).toBe("background lines");
  });
  it("auf einer gewöhnlichen Seite lehnen beide ab", () => {
    const { store, call } = setup();
    const page = createPage(store, { title: "Plain" });
    expect(call("read_board", { page_id: page }).isError).toBe(true);
    expect(call("draw_board", { page_id: page, script: "note a: x" }).isError).toBe(true);
  });
});
