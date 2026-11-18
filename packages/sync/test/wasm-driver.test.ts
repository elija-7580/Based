// ADR 0017 A1: der Browser-Treiber (SQLite-WASM) mit wiederverwendeten Anweisungen liefert dasselbe wie der
// Node-Treiber – auf dem Fixture-Korpus, mit BLOBs, großen Zahlen und NULL –, erholt sich nach einem Fehler und gibt
// beim Schließen alles frei.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { safeParseRecord, type WireRecord } from "@based/core";
import { openNodeDatabase } from "../src/drivers/node.js";
import { openWasmDatabase } from "../src/drivers/wasm.js";
import { SqlitePersistence } from "../src/persistence.js";
import type { SqlDatabase } from "../src/sql.js";

const corpus: WireRecord[] = readFileSync(new URL("../../../fixtures/records/corpus.jsonl", import.meta.url), "utf8")
  .split("\n").filter(Boolean).map((l) => safeParseRecord(JSON.parse(l))).flatMap((r) => (r.ok ? [r.record] : []));

const normal = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
  [k, v instanceof Uint8Array ? "blob:" + Buffer.from(v).toString("hex") : typeof v === "bigint" ? Number(v) : v])));

describe("SQLite-WASM-Treiber", () => {
  it("liefert dieselben Zeilen wie der Node-Treiber (Korpus, BLOB, große Zahl, NULL, leerer Text)", async () => {
    expect(corpus.length).toBeGreaterThan(20);
    const dbs: SqlDatabase[] = [await openWasmDatabase(), openNodeDatabase()];
    const dumps = dbs.map((db) => {
      const p = new SqlitePersistence(db);
      p.write(corpus, [], new Map(), true);
      p.write(corpus.slice(0, 5), [`${corpus[6]!.kind}:${corpus[6]!.data.id}`], new Map(), false);
      db.exec("CREATE TABLE t(a INTEGER, b BLOB, c TEXT, d REAL)");
      db.run("INSERT INTO t VALUES(?, ?, ?, ?)", [9_007_199_254_740_991, new Uint8Array([0, 255, 1, 2]), "", 1.5]);
      db.run("INSERT INTO t VALUES(?, ?, ?, ?)", [-3, null, "ünïcödé 🙂", null]);
      const loaded = p.loadAll().map((r) => JSON.stringify(r)).sort();
      return {
        records: normal(db.all("SELECT kind, id, data FROM records ORDER BY kind, id")),
        changes: normal(db.all("SELECT kind, id, deleted, local FROM changes ORDER BY kind, id")),
        t: normal(db.all("SELECT a, b, c, d FROM t ORDER BY a")),
        one: normal(db.all("SELECT COUNT(*) AS n FROM records WHERE kind = ?", ["block"])),
        loaded,
        undecodable: p.undecodable.length,
      };
    });
    expect(dumps[0]).toEqual(dumps[1]);
    expect(dumps[0]!.records.length).toBeGreaterThan(20);
    for (const db of dbs) db.close();
  });

  it("dieselbe Anweisung oft hintereinander, mit wechselnden Parametern, in und außerhalb einer Transaktion", async () => {
    const db = await openWasmDatabase();
    db.exec("CREATE TABLE n(i INTEGER PRIMARY KEY, s TEXT)");
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < 2000; i++) db.run("INSERT INTO n VALUES(?, ?)", [i, "v" + i]);
    db.exec("COMMIT");
    expect(db.all("SELECT COUNT(*) AS n FROM n")[0]!.n).toBe(2000);
    expect(db.all("SELECT s FROM n WHERE i = ?", [1234])[0]!.s).toBe("v1234");
    expect(db.all("SELECT s FROM n WHERE i = ?", [7])[0]!.s).toBe("v7");
    expect(db.all("SELECT s FROM n WHERE i = ?", [99999])).toEqual([]);
    db.close();
  });

  it("nach einem Fehler (doppelter Schlüssel) läuft dieselbe Anweisung weiter und hält keine Transaktion offen", async () => {
    const db = await openWasmDatabase();
    db.exec("CREATE TABLE u(i INTEGER PRIMARY KEY)");
    db.run("INSERT INTO u(i) VALUES(?)", [1]);
    expect(() => db.run("INSERT INTO u(i) VALUES(?)", [1])).toThrow();
    db.run("INSERT INTO u(i) VALUES(?)", [2]);
    db.exec("BEGIN IMMEDIATE");
    expect(() => db.run("INSERT INTO u(i) VALUES(?)", [2])).toThrow();
    db.exec("ROLLBACK");
    db.exec("BEGIN IMMEDIATE");
    db.run("INSERT INTO u(i) VALUES(?)", [3]);
    db.exec("COMMIT");
    expect(db.all("SELECT i FROM u ORDER BY i").map((r) => r.i)).toEqual([1, 2, 3]);
    // Schema ändert sich unter einer gemerkten Anweisung: SQLite bereitet sie selbst neu vor.
    db.exec("ALTER TABLE u ADD COLUMN extra TEXT");
    db.run("INSERT INTO u(i) VALUES(?)", [4]);
    expect(db.all("SELECT i FROM u ORDER BY i").length).toBe(4);
    db.close();
  });

  it("viele verschiedene Anweisungen sprengen den Cache nicht; Schließen gibt alles frei", async () => {
    const db = await openWasmDatabase();
    db.exec("CREATE TABLE m(i INTEGER)");
    for (let i = 0; i < 600; i++) db.run(`INSERT INTO m VALUES(${i})`);
    expect(db.all("SELECT COUNT(*) AS n FROM m")[0]!.n).toBe(600);
    expect(() => db.close()).not.toThrow();
    expect(() => db.all("SELECT 1")).toThrow();
  });
});
