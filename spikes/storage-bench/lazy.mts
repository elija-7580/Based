// ADR 0017 Stufe B, Messung: virtuelle Spalten (parent, type) über dem JSON, ohne die Zeilen umzuschreiben.
// Aufruf (aus apps/cli): node --import tsx ../../spikes/storage-bench/lazy.mts [node|wasm]
import { copyFileSync, readFileSync, statSync } from "node:fs";
const src = "/tmp/based-bench/w-20000x25.sqlite", path = "/tmp/based-bench/lazy.sqlite";
copyFileSync(src, path);
const mode = process.argv[2] ?? "node";
const mb = (n: number) => (n / 1048576).toFixed(1) + " MB";
type DB = { exec(sql: string): void; all(sql: string, p?: unknown[]): Record<string, unknown>[]; close(): void };
let db: DB;
if (mode === "node") {
  const { openNodeDatabase } = await import("../../packages/sync/src/drivers/node.ts");
  db = openNodeDatabase(path) as unknown as DB;
} else {
  // Browser-SQLite (WASM, im Speicher): 100 000 Zeilen aus der Messdatei übernehmen.
  const { openWasmDatabase } = await import("../../packages/sync/src/drivers/wasm.ts");
  const { openNodeDatabase } = await import("../../packages/sync/src/drivers/node.ts");
  const w = await openWasmDatabase();
  w.exec("CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(kind, id))");
  const from = openNodeDatabase(src);
  w.exec("BEGIN");
  for (const r of from.all("SELECT kind, id, data FROM records LIMIT 100000")) w.run("INSERT INTO records(kind, id, data) VALUES(?, ?, ?)", [r.kind, r.id, r.data]);
  w.exec("COMMIT");
  from.close();
  db = { exec: (q) => w.exec(q), all: (q, b = []) => w.all(q, b as never) as never, close: () => w.close() };
}
const t = <T,>(label: string, f: () => T): T => { const a = performance.now(); const r = f(); console.log(`[${mode}] ${label}`.padEnd(64), (performance.now() - a).toFixed(1) + " ms"); return r; };
console.log(`[${mode}] sqlite`, db.all("SELECT sqlite_version() v")[0]!.v, "Zeilen", db.all("SELECT count(*) n FROM records")[0]!.n);
const pages0 = () => db.all("SELECT count(*) n FROM records").length;
t("Spalten anlegen (virtuell, kein Umschreiben)", () => db.exec(`
  ALTER TABLE records ADD COLUMN parent TEXT GENERATED ALWAYS AS (json_extract(CAST(data AS TEXT), '$.parent')) VIRTUAL;
  ALTER TABLE records ADD COLUMN type TEXT GENERATED ALWAYS AS (json_extract(CAST(data AS TEXT), '$.type')) VIRTUAL;`));
t("Index parent", () => db.exec("CREATE INDEX records_parent ON records(kind, parent)"));
t("Index type (nur Gerüst: page-artige)", () => db.exec("CREATE INDEX records_skeleton ON records(kind, type) WHERE kind = 'block' AND type IN ('page','database','row')"));
const skel = t("Gerüst lesen: alle Seiten + Nicht-Blöcke", () => db.all("SELECT kind, id, data FROM records WHERE (kind = 'block' AND type IN ('page','database','row')) OR kind != 'block'"));
t("Gerüst JSON.parse", () => skel.map((r) => JSON.parse(typeof r.data === "string" ? r.data : new TextDecoder().decode(r.data as Uint8Array))));
const ids = skel.filter((r) => r.kind === "block").map((r) => r.id as string);
t("100 Seiten: Blöcke je Seite (parent-Index)", () => { for (let i = 0; i < 100; i++) db.all("SELECT kind, id, data FROM records WHERE kind = 'block' AND parent = ?", ["b:" + ids[(i * 197) % ids.length]]); });
t("1000 Einzelzugriffe per Schlüssel", () => { for (let i = 0; i < 1000; i++) db.all("SELECT data FROM records WHERE kind = 'block' AND id = ?", [ids[(i * 31) % ids.length]]); });
t("5000 Zeilen schreiben (mit Indexpflege)", () => { db.exec("BEGIN"); for (let i = 0; i < 5000; i++) db.all("INSERT OR REPLACE INTO records(kind, id, data) VALUES('block', ?, ?)", ["n" + i, JSON.stringify({ id: "n" + i, type: "text", parent: "b:" + ids[i % ids.length], sk: "a0", text: "hello world ".repeat(8) })]); db.exec("COMMIT"); });
console.log(`[${mode}] Gerüst`, skel.length, "Zeilen; EXPLAIN:", db.all("EXPLAIN QUERY PLAN SELECT id FROM records WHERE kind = 'block' AND parent = 'b:x'").map((r) => r.detail).join(" | "));
if (mode === "node") { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close(); console.log("Datei vorher", mb(statSync(src).size), "nachher", mb(statSync(path).size)); }
void pages0;
