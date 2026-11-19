// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// Laden in Stücken (`SqlitePersistence.scanRecords`): SQLite setzt je Stück einen JSON-Text zusammen. Das darf am
// Ergebnis nichts ändern – dieselben Records in derselben Reihenfolge, dieselben unlesbaren Zeilen mit denselben
// Meldungen wie beim Lesen Zeile für Zeile, und die Datei bleibt unberührt.
import { describe, expect, it } from "vitest";
import { keyOf, safeParseRecord, type RecordKind, type WireRecord } from "@based/core";
import { SqlitePersistence } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import { openWasmDatabase } from "../src/drivers/wasm.js";
import { asText, utf8, type SqlDatabase } from "../src/sql.js";

const KINDS = new Set(["workspace", "block", "database", "view", "property"]);

/** Das alte Verhalten, Zeile für Zeile – die Referenz. */
function reference(db: SqlDatabase): { records: WireRecord[]; undecodable: { key: string; error: string }[] } {
  const records: WireRecord[] = [];
  const undecodable: { key: string; error: string }[] = [];
  for (const row of db.all("SELECT kind, id, data FROM records ORDER BY rowid")) {
    const kind = asText(row.kind) as RecordKind, id = asText(row.id) ?? "";
    const fail = (error: string) => void undecodable.push({ key: keyOf(kind, id), error });
    if (!KINDS.has(kind)) { fail(`unknown record kind ${kind}`); continue; }
    try {
      const parsed = safeParseRecord({ kind, data: JSON.parse(asText(row.data) ?? "") });
      if (parsed.ok) records.push(parsed.record);
      else fail(parsed.error.message);
    } catch (e) {
      fail(String(e));
    }
  }
  return { records, undecodable };
}

const block = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "text", parent: "b:P", sk: "a0", text: `Text of ${id} – „quotes“ \\ "and" \u2028 emoji 🙂`, createdAt: 1, updatedAt: 2, stamp: { millis: 5, counter: 1, node: "N" }, ...extra });

function fill(db: SqlDatabase, n: number) {
  const put = (kind: string, id: string, data: string | Uint8Array) => db.run("INSERT INTO records(kind, id, data) VALUES(?, ?, ?)", [kind, id, typeof data === "string" ? utf8(data) : data]);
  db.exec("BEGIN");
  put("block", "P", JSON.stringify({ ...block("P"), type: "page", parent: "w" }));
  for (let i = 0; i < n; i++) {
    put("block", `B${i}`, JSON.stringify(block(`B${i}`, i % 7 === 0 ? { text: [{ t: "a" }, { t: "b", m: { b: true } }], unknownField: { keep: [1, 2, 3] } } : {})));
    // Unlesbares verteilt über die Stücke, auch an deren Rändern
    if (i % 997 === 0) put("block", `broken${i}`, "{kein json");
    if (i % 1499 === 0) put("block", `odd${i}`, JSON.stringify({ id: `odd${i}`, type: "page", parent: 7 }));
    if (i === 2047) put("block", "empty", " ");
    if (i === 2048) put("gizmo", "future", JSON.stringify({ id: "future" }));
    if (i === 2049) put("block", "null", "null");
    if (i === 3000) put("block", "nul", new Uint8Array([...utf8(JSON.stringify(block("nul"))), 0, ...utf8('},{"r":1,"k":"block","i":"x","d":{}')]));
    if (i === 3001) put("block", 'quote"id\\', JSON.stringify(block('quote"id\\')));
    if (i === 3002) put("block", "trailing", JSON.stringify(block("trailing")) + "   \n");
    if (i === 3003) put("block", "twice", JSON.stringify(block("twice")) + "," + JSON.stringify(block("twice")));
    if (i === 3004) put("block", "badutf8", new Uint8Array([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
  }
  db.exec("COMMIT");
}

const drivers: [string, () => Promise<SqlDatabase>][] = [
  ["node:sqlite", () => Promise.resolve(openNodeDatabase())],
  ["SQLite-WASM", () => openWasmDatabase()],
];

describe.each(drivers)("Laden in Stücken (%s)", (_name, open) => {
  it("liefert dasselbe wie Zeile für Zeile: Records, Reihenfolge, unlesbare Zeilen und ihre Meldungen", async () => {
    const db = await open();
    const p = new SqlitePersistence(db);
    fill(db, 5000);
    const before = db.all("SELECT kind, id, hex(data) AS h FROM records ORDER BY rowid");
    const want = reference(db);
    expect(want.records.length).toBeGreaterThan(5000);
    expect(want.undecodable.map((u) => u.key)).toEqual(expect.arrayContaining(["block:broken0", "block:odd0", "block:empty", "gizmo:future", "block:null", "block:nul", "block:twice"]));
    const got = p.loadAll();
    expect(got).toEqual(want.records);
    expect(p.undecodable).toEqual(want.undecodable);
    // Nichts untergeschoben: der Text hinter dem NUL-Zeichen wird nie zu einem eigenen Record
    expect(got.some((r) => r.data.id === "x")).toBe(false);
    expect(db.all("SELECT kind, id, hex(data) AS h FROM records ORDER BY rowid")).toEqual(before);
    db.close();
  });

  it("loadRemaining: nur Blöcke, ohne die schon bekannten", async () => {
    const db = await open();
    const p = new SqlitePersistence(db);
    fill(db, 2500);
    db.run("INSERT INTO records(kind, id, data) VALUES('workspace', 'W', ?)", [utf8("{}")]);
    const want = reference(db).records.filter((r) => r.kind === "block" && !r.data.id.endsWith("7")).map((r) => r.data);
    expect(p.lazy.loadRemaining((id) => id.endsWith("7"))).toEqual(want);
    db.close();
  });

  it("leere Datei und genau ein volles Stück", async () => {
    const db = await open();
    const p = new SqlitePersistence(db);
    expect(p.loadAll()).toEqual([]);
    db.exec("BEGIN");
    for (let i = 0; i < 2048; i++) db.run("INSERT INTO records(kind, id, data) VALUES('block', ?, ?)", [`B${i}`, utf8(JSON.stringify(block(`B${i}`)))]);
    db.exec("COMMIT");
    expect(p.loadAll().map((r) => r.data.id)).toEqual(reference(db).records.map((r) => r.data.id));
    expect(p.loadAll()).toHaveLength(2048);
    db.close();
  });
});
