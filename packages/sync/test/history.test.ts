// BSD-73: Versionsverlauf in history.sqlite (Format wie Swift VersionHistory.swift).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyHash, VersionHistory, type Block } from "@based/core";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteHistoryStorage } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import type { SqlDatabase } from "../src/sql.js";

const block = (id: string, parent: string, text: string): Block =>
  ({ id, type: id === "P" ? "page" : "text", parent, sk: "a0", text, createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "x" } }) as Block;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempFile = () => {
  const d = mkdtempSync(join(tmpdir(), "based-history-"));
  dirs.push(d);
  return join(d, "history.sqlite");
};

describe("SqliteHistoryStorage", () => {
  it("speichert dauerhaft, dedupliziert und liest nach dem Wiederöffnen", () => {
    const file = tempFile();
    const db = openNodeDatabase(file);
    const h = new VersionHistory(new SqliteHistoryStorage(db));
    const v1 = h.record("P", [block("P", "w", "Seite"), block("t", "b:P", "eins")], "Seite", "opened", 1_800_000_000)!;
    expect(h.record("P", [block("P", "w", "Seite"), block("t", "b:P", "eins")], "Seite", "edit", 1_800_000_060)).toBeNull();
    const v2 = h.record("P", [block("P", "w", "Seite"), block("t", "b:P", "zwei drei")], "Seite", "edit", 1_800_000_120)!;
    expect(h.stats()).toMatchObject({ versions: 2, objects: 5 }); // Seite einmal geteilt
    db.close();

    const again = new VersionHistory(new SqliteHistoryStorage(openNodeDatabase(file)));
    expect(again.versions("P").map((v) => [v.id, v.at, v.reason, v.wordCount])).toEqual([[v2.id, 1_800_000_120, "edit", 2], [v1.id, 1_800_000_000, "opened", 1]]);
    expect(again.blocksOf(v1)).toMatchObject({ missing: [], blocks: [{ id: "P" }, { id: "t", text: "eins" }] });
  });

  it("liest eine Datei, wie Swift sie schreibt (rohe Objekte mit Flag 0, `at` in Unix-Sekunden)", () => {
    const db = openNodeDatabase();
    // Tabellen so, wie VersionHistory.swift sie anlegt
    db.exec(`CREATE TABLE objects (hash TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, page TEXT NOT NULL, at REAL NOT NULL, manifest TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', blocks INTEGER NOT NULL DEFAULT 0, words INTEGER NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '');
      CREATE INDEX versions_page ON versions(page, at);`);
    const enc = new TextEncoder();
    const raw = (s: string) => new Uint8Array([0, ...enc.encode(s)]);
    const pageJSON = '{"createdAt":0,"id":"P","parent":"w","sk":"a0","stamp":{"counter":0,"millis":1,"node":"x"},"text":"Seite","type":"page","updatedAt":0}';
    const manifest = `P\t${historyHash(pageJSON)}`;
    db.run("INSERT INTO objects VALUES (?, ?)", [historyHash(pageJSON), raw(pageJSON)]);
    db.run("INSERT INTO objects VALUES (?, ?)", [historyHash(manifest), raw(manifest)]);
    db.run("INSERT INTO versions(page, at, manifest, title, blocks, words, reason) VALUES ('P', 1800000000.5, ?, 'Seite', 0, 0, 'opened')", [historyHash(manifest)]);
    const h = new VersionHistory(new SqliteHistoryStorage(db));
    const [v] = h.versions("P");
    expect(v).toMatchObject({ at: 1_800_000_000.5, title: "Seite", reason: "opened" });
    expect(h.blocksOf(v!).blocks[0]).toMatchObject({ id: "P", text: "Seite" });
    // gleicher Inhalt wie die Swift-Version → keine neue Version
    expect(h.record("P", [JSON.parse(pageJSON) as Block], "Seite")).toBeNull();
  });

  it("Schreibfehler: Transaktion zurückgerollt, Fehler kommt beim Aufrufer an", () => {
    const inner = openNodeDatabase();
    let fail = true;
    const db: SqlDatabase = {
      ...inner,
      run: (sql, params) => {
        if (fail && sql.startsWith("INSERT INTO versions")) throw new Error("disk I/O error");
        inner.run(sql, params);
      },
    };
    const storage = new SqliteHistoryStorage(db);
    const h = new VersionHistory(storage);
    const blocks = [block("P", "w", "Seite"), block("t", "b:P", "eins")];
    expect(() => h.record("P", blocks, "Seite")).toThrow("disk I/O error");
    expect(storage.stats()).toEqual({ versions: 0, objects: 0, bytes: 0 });
    fail = false;
    const v = h.record("P", blocks, "Seite")!;
    expect(h.blocksOf(v).missing).toEqual([]); // Objekte wurden neu geschrieben, nicht als „bekannt“ übersprungen
  });

  it("ausdünnen, forget und aufräumen", () => {
    const h = new VersionHistory(new SqliteHistoryStorage(openNodeDatabase()));
    const now = 1_800_000_000;
    for (let i = 0; i < 5; i++) h.record("P", [block("P", "w", "Seite"), block("t", "b:P", `v${i}`)], "Seite", "edit", now - 3 * 86_400 - 1_800 - i * 60);
    expect(h.prune(now)).toBe(4); // alle in derselben Stunde vor drei Tagen → die neueste bleibt
    expect(h.collectGarbage()).toBe(8);
    h.forget("P");
    expect(h.versions("P")).toEqual([]);
  });
});
