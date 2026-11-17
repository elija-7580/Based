// ADR 0017 Stufe B: Laden nach Bedarf auf SQLite – Indizes über dem JSON, ohne die Zeilen umzuschreiben.
import { describe, expect, it } from "vitest";
import { isSkeletonBlock, keysBetween, WorkspaceStore, type Block, type WireRecord } from "@based/core";
import { LAZY_INDEXES, openWorkspace, PARENT_SQL, SKELETON_SQL, SqlitePersistence } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import { openWasmDatabase } from "../src/drivers/wasm.js";
import type { SqlDatabase } from "../src/sql.js";

const block = (id: string, type: string, parent: string, sk: string, extra: Partial<Block> = {}): WireRecord =>
  ({ kind: "block", data: { id, type, parent, sk, text: "text of " + id, createdAt: 0, updatedAt: 0, stamp: { millis: 5, counter: 0, node: "seed" }, ...extra } }) as WireRecord;

function workspace(): WireRecord[] {
  const out: WireRecord[] = [];
  const types = ["text", "todo", "toggle", "heading2", "databaseInline", "code"];
  const pk = keysBetween(8, undefined, undefined);
  for (let p = 0; p < 8; p++) {
    out.push(block("P" + p, p === 6 ? "databasePage" : "page", p < 4 ? "w" : "b:P" + (p - 4), pk[p]!, p === 7 ? { trashedAt: 9 } : {}));
    const keys = keysBetween(6, undefined, undefined);
    for (let j = 0; j < 6; j++) out.push(block(`P${p}-${j}`, types[j]!, "b:P" + p, keys[j]!, j === 5 && p === 2 ? { trashedAt: 3 } : {}));
  }
  return out;
}

function seeded(db: SqlDatabase) {
  const p = new SqlitePersistence(db);
  p.write(workspace(), [], new Map(), true);
  return p;
}
const utf8 = (s: string) => new TextEncoder().encode(s);

for (const [name, open] of [["node:sqlite", async () => openNodeDatabase()], ["SQLite-WASM (wie im Browser)", () => openWasmDatabase()]] as const) {
  describe(`Laden nach Bedarf auf ${name}`, () => {
    it("Gerüst in SQL = isSkeletonBlock über alle Records (beide Regeln bleiben gleich)", async () => {
      const db = await open();
      const p = seeded(db);
      const all = p.loadAll();
      const expected = all.filter((r) => r.kind !== "block" || isSkeletonBlock(r.data)).map((r) => r.data.id).sort();
      expect(p.lazy.loadSkeleton().map((r) => r.data.id).sort()).toEqual(expected);
      expect(expected).toContain("P2-5"); // im Papierkorb, kein Seitentyp
      expect(expected).toContain("P0-4"); // databaseInline
      expect(expected).not.toContain("P0-0");
      db.close();
    });

    it("Abfragen nutzen die Indizes; Kinder je Elternteil vollständig; nach ID in Stücken", async () => {
      const db = await open();
      const p = seeded(db);
      p.ensureLazyIndexes();
      const plan = (sql: string) => db.all("EXPLAIN QUERY PLAN " + sql).map((r) => String(r.detail)).join(" | ");
      expect(plan(`SELECT id FROM records WHERE kind = 'block' AND ${PARENT_SQL} = 'b:P0'`)).toMatch(/USING INDEX records_parent/);
      expect(plan(`SELECT id FROM records WHERE kind = 'block' AND ${SKELETON_SQL} = 1`)).toMatch(/records_skeleton/);
      expect(p.lazy.loadChildren(["b:P0"]).map((b) => b.id).sort()).toEqual(["P0-0", "P0-1", "P0-2", "P0-3", "P0-4", "P0-5", "P4"]);
      expect(p.lazy.loadChildren(["b:P1", "b:P3", "b:nope"]).length).toBe(7 + 7);
      const ids = workspace().map((r) => r.data.id);
      expect(p.lazy.loadBlocks([...ids, "missing"]).length).toBe(ids.length);
      expect(p.lazy.loadBlocks(Array.from({ length: 250 }, (_, i) => ids[i % ids.length]!)).length).toBeGreaterThanOrEqual(ids.length);
      expect(p.lazy.loadBlocks(["P3-2"])[0]?.parent).toBe("b:P3");
      expect(p.lazy.countBlocks()).toBe(56);
      const hits: string[] = [];
      p.lazy.scanBlocks(["text of P3-2", "text of P6-0", "nirgends"], (b) => hits.push(b.id));
      expect(hits.sort()).toEqual(["P3-2", "P6-0"]);
      db.close();
    });

    it("unlesbare Zeilen (BSD-16) stören weder den Index noch späteres Schreiben und bleiben unangetastet", async () => {
      const db = await open();
      const p = seeded(db);
      db.run("INSERT INTO records(kind, id, data) VALUES('block', 'broken', ?)", [utf8("{kein json")]);
      db.run("INSERT INTO records(kind, id, data) VALUES('block', 'empty', ?)", [utf8(" ")]);
      db.run("INSERT INTO records(kind, id, data) VALUES('gizmo', 'future', ?)", [utf8('{"id":"future","parent":"b:P0"}')]);
      db.run("INSERT INTO records(kind, id, data) VALUES('block', 'odd', ?)", [utf8('{"id":"odd","type":"page","parent":7}')]);
      p.ensureLazyIndexes();
      p.ensureLazyIndexes(); // wiederholbar
      const { store } = openWorkspace(db, { node: "dev", lazy: true, propertyRecords: false });
      expect(store.isPartial).toBe(true);
      expect(store.children("b:P0")).toHaveLength(7);
      // eine unlesbare Zeile überschreiben und eine neue daneben schreiben: der Index macht mit
      db.run("UPDATE records SET data = ? WHERE id = 'broken'", [utf8("{immer noch kaputt")]);
      store.transact("t", (tx) => tx.update("P0-0", (b) => { b.text = "geändert"; }));
      expect(store.blocks.get("broken")).toBeUndefined();
      expect([...store.blocks.values()].some((b) => b.id === "broken")).toBe(false);
      expect(store.persistence && (store.persistence as SqlitePersistence).undecodable.map((u) => u.key).sort()).toEqual(["block:broken", "block:empty", "block:odd", "gizmo:future"]);
      expect(db.all("SELECT count(*) AS n FROM records WHERE id IN ('broken', 'empty', 'future', 'odd')")[0]!.n).toBe(4);
      db.close();
    });

    it("Rückweg: ohne die Indizes öffnet die Datei wie vorher; ein Build ohne Laden nach Bedarf schreibt weiter hinein", async () => {
      const db = await open();
      const p = seeded(db);
      const before = openWorkspace(db, { node: "a", lazy: true, propertyRecords: false }).store;
      before.transact("t", (tx) => tx.update("P1-0", (b) => { b.text = "aus dem neuen Build"; }));
      expect(db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'records_%'").map((r) => r.name).sort()).toEqual([...LAZY_INDEXES].sort());
      // „alter Build“: schreibt mit den bisherigen Anweisungen, kennt weder Indizes noch den gemerkten Stempel
      db.run("INSERT OR REPLACE INTO records(kind, id, data) VALUES('block', 'P1-0', ?)", [utf8(JSON.stringify({ ...block("P1-0", "text", "b:P5", "a0").data, stamp: { millis: Date.now() + 5000, counter: 9, node: "old" } }))]);
      db.run("DELETE FROM changes WHERE kind = 'block' AND id = 'P1-0'");
      db.run("INSERT INTO changes(kind, id, deleted, local) VALUES('block', 'P1-0', 0, 1)");
      const again = openWorkspace(db, { node: "a", lazy: true, propertyRecords: false }).store;
      expect(again.children("b:P5")).toContain("P1-0"); // der Index kennt den Umzug
      expect(again.children("b:P1")).not.toContain("P1-0");
      expect(again.clock.current.millis).toBeGreaterThan(Date.now()); // der gemerkte Stempel wurde neu bestimmt
      p.dropLazyIndexes();
      expect(db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'records_%'")).toEqual([]);
      const eager = openWorkspace(db, { node: "a", lazy: false, propertyRecords: false }).store;
      expect(eager.isPartial).toBe(false);
      expect(eager.blocks.size).toBe(56);
      db.close();
    });

    it("gleicher Stand wie voll geladen, auch nach Schreiben, Löschen und Neuöffnen", async () => {
      const db = await open();
      seeded(db);
      const lazy = () => openWorkspace(db, { node: "dev", lazy: true, propertyRecords: false, now: () => 1000 }).store;
      const a = lazy();
      a.transact("t", (tx) => { tx.update("P3-1", (b) => { b.parent = "b:P0"; b.sk = a.endKey("b:P0"); }); tx.remove("block:P2-0"); tx.put(block("new", "text", "b:P4", "a0")); });
      const b = lazy();
      expect(b.blocks.loadedSize).toBeLessThan(20);
      expect(b.children("b:P0")).toContain("P3-1");
      expect(b.blocks.get("P2-0")).toBeUndefined();
      expect(b.blocks.size).toBe(56);
      const eager = new WorkspaceStore({ persistence: new SqlitePersistence(db), node: "dev", lazy: false, propertyRecords: false, now: () => 1000 });
      const sorted = (s: WorkspaceStore) => s.allRecords().map((r) => JSON.stringify(r)).sort();
      expect(sorted(b)).toEqual(sorted(eager));
      for (const parent of ["w", ...workspace().map((r) => "b:" + r.data.id)]) expect(lazy().children(parent)).toEqual(eager.children(parent));
      db.close();
    });

    it("Suche in der Datei: Groß/Klein egal, % und _ wörtlich, leere Liste = alle Blöcke", async () => {
      const db = await open();
      const p = seeded(db);
      p.write([block("pct", "text", "b:P0", "z1", { text: "Rabatt 100% sicher" }), block("und", "text", "b:P0", "z2", { text: "snake_case Name" }), block("x", "text", "b:P0", "z3", { text: "100 Prozent, snakeXcase" })], [], new Map(), true);
      const ids = (containing: string[], ignoreCase = false) => { const out: string[] = []; p.lazy.scanBlocks(containing, (b) => out.push(b.id), { ignoreCase }); return out.sort(); };
      expect(ids(["100% SICHER"], true)).toEqual(["pct"]);
      expect(ids(["100% SICHER"])).toEqual([]);
      expect(ids(["SNAKE_case"], true)).toEqual(["und"]);
      expect(ids([]).length).toBe(59);
      db.close();
    });

    it("der gemerkte neueste Stempel bleibt gültig: nach Ändern, Löschen und Neuöffnen wird die Datei nicht neu abgesucht", async () => {
      const db = await open();
      seeded(db);
      const lazy = () => openWorkspace(db, { node: "dev", lazy: true, propertyRecords: false });
      const first = lazy(); // bestimmt den Stempel einmal und merkt ihn
      first.store.transact("t", (tx) => { tx.update("P0-1", (b) => { b.text = "neu"; }); tx.remove("block:P0-2"); });
      first.persistence.promoteDerived();
      const scans: string[] = [];
      const all = db.all.bind(db);
      db.all = (sql, params) => { if (/ORDER BY json_extract/.test(sql)) scans.push(sql); return all(sql, params); };
      const again = lazy();
      expect(scans).toEqual([]);
      // die Uhr steht mindestens beim Stempel der Änderung (der Stempel der Löschung zählt nicht, wie beim vollen Laden)
      const edited = first.store.blocks.get("P0-1")!.stamp as { millis: number };
      expect(again.store.clock.current.millis).toBeGreaterThanOrEqual(edited.millis);
      db.close();
    });

    it("ohne Laden nach Bedarf geöffnet: die Indizes verschwinden wieder (Rückweg ohne Zutun)", async () => {
      const db = await open();
      seeded(db);
      const names = () => db.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'records_%'").map((r) => r.name);
      openWorkspace(db, { node: "dev", lazy: true, propertyRecords: false });
      expect(names().length).toBe(2);
      const eager = openWorkspace(db, { node: "dev", lazy: false, propertyRecords: false }).store;
      expect(names()).toEqual([]);
      expect(eager.blocks.size).toBe(56);
      db.close();
    });
  });
}
