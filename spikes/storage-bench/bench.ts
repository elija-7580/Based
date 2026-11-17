// Messung: großer Workspace – Dateigröße, Laden, Speicher, Schreiben, Sync-Größe.
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { rmSync, statSync } from "node:fs";
import { openNodeDatabase } from "../../packages/sync/src/drivers/node.ts";
import { openWorkspace, SqlitePersistence } from "../../packages/sync/src/persistence.ts";
import { buildOutline, canonicalStringify, keysBetween, safeParseRecord, type Block, type WireRecord } from "../../packages/core/src/index.ts";

const PAGES = Number(process.argv[2] ?? 20000), PER = Number(process.argv[3] ?? 25);
const path = `/tmp/based-bench/w-${PAGES}x${PER}.sqlite`;
const WORDS = "the of and to in is that for it as with was on be by at this have from or one had not but what all were when we there can an your which their said if do will each about how up out them then she many some so these would other into has more her two like him see time could no make than first been its who now people my made over did down only way find use may water long little very after words called just where most know".split(" ");
let seed = 42; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const text = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ");
const uuid = () => crypto.randomUUID().toUpperCase();
const mb = (n: number) => (n / 1048576).toFixed(1) + " MB";
const t = <T,>(label: string, f: () => T): T => { const a = performance.now(); const r = f(); console.log(label.padEnd(46), (performance.now() - a).toFixed(0) + " ms"); return r; };

function generate() {
  for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
  const db = openNodeDatabase(path);
  const p = new SqlitePersistence(db);
  const TYPES = ["text", "text", "text", "text", "bulletedList", "bulletedList", "todo", "heading2", "quote", "code"];
  let millis = 1793974300424, counter = 0, total = 0;
  const pk = keysBetween(PAGES, undefined, undefined);
  let batch: WireRecord[] = [];
  const flush = () => { if (batch.length) { p.write(batch, [], new Map(), false); total += batch.length; batch = []; } };
  for (let i = 0; i < PAGES; i++) {
    const pid = uuid();
    const stamp = () => ({ millis: millis += 7, counter: counter++ % 300, node: "3C8ED7C0" });
    const now = 815_000_000 + i * 60.123456;
    batch.push({ kind: "block", data: { id: pid, type: "page", parent: i % 10 === 0 || i < 10 ? "w" : "b:" + (batch.find((r) => r.data.type === "page")?.data.id ?? pid), sk: pk[i]!, text: text(4), createdAt: now, updatedAt: now, createdBy: "me", updatedBy: "me", stamp: stamp() } as Block });
    const keys = keysBetween(PER, undefined, undefined);
    for (let j = 0; j < PER; j++) {
      const type = TYPES[Math.floor(rnd() * TYPES.length)]!;
      const b = { id: uuid(), type, parent: "b:" + pid, sk: keys[j]!, text: rnd() < 0.15 ? [{ t: text(6) }, { t: text(3), m: { b: true } }, { t: text(8) }] : text(type === "heading2" ? 4 : 6 + Math.floor(rnd() * 30)), createdAt: now + j, updatedAt: now + j * 1.5, createdBy: "me", updatedBy: "me", stamp: stamp() } as Block;
      if (type === "todo") b.props = { checked: rnd() < 0.5 };
      batch.push({ kind: "block", data: b });
    }
    if (batch.length >= 5000) flush();
  }
  flush();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return total;
}

const mode = process.argv[4] ?? "all";
if (mode === "gen" || mode === "all") console.log("records", t("generate", generate), "file", mb(statSync(path).size));

if (mode !== "gen") {
  const db = openNodeDatabase(path);
  const rows = t("1 SQL: SELECT alle Zeilen", () => db.all("SELECT kind, id, data FROM records"));
  let bytes = 0; const dec = new TextDecoder();
  const strs = t("2 UTF-8 dekodieren", () => rows.map((r) => { const s = typeof r.data === "string" ? r.data : dec.decode(r.data as Uint8Array); bytes += s.length; return s; }));
  const objs = t("3 JSON.parse", () => strs.map((s) => JSON.parse(s)));
  t("4 zod safeParseRecord", () => objs.map((o) => safeParseRecord({ kind: "block", data: o })));
  console.log("JSON gesamt", mb(bytes), "Records", rows.length, "Ø", (bytes / rows.length).toFixed(0), "B");
  // Anteil der Verwaltungsfelder
  let stampB = 0, idB = 0, timeB = 0, textB = 0, byB = 0;
  for (const o of objs as Block[]) {
    stampB += JSON.stringify(o.stamp).length + 8; idB += o.id.length + o.parent.length + 20; timeB += String(o.createdAt).length + String(o.updatedAt).length + 24;
    textB += JSON.stringify(o.text ?? "").length; byB += 34;
  }
  console.log("Anteile:", "Text", mb(textB), "· stamp", mb(stampB), "· id+parent", mb(idB), "· Zeiten", mb(timeB), "· createdBy/updatedBy", mb(byB));
  const all = "[" + strs.join(",") + "]";
  console.log("Voll-Pull JSON", mb(all.length), "gzip", mb(t("gzip -6", () => gzipSync(all, { level: 6 })).length), "brotli-5", mb(t("brotli 5", () => brotliCompressSync(all, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } })).length));
  db.close();
  (globalThis as { gc?: () => void }).gc?.();
  const h0 = process.memoryUsage().heapUsed;
  const db2 = openNodeDatabase(path);
  const { store } = t("5 openWorkspace gesamt (Laden + Index)", () => openWorkspace(db2, { node: "BENCH" }));
  (globalThis as { gc?: () => void }).gc?.();
  console.log("Heap nach dem Öffnen", mb(process.memoryUsage().heapUsed - h0), "· Blöcke", store.blocks.size);
  const outline = t("6 buildOutline (Seitenleiste)", () => buildOutline(store));
  console.log("Outline JSON an den Hauptthread", mb(JSON.stringify(outline).length));
  // Tippen: eine Taste = ein Record schreiben
  const some = [...store.blocks.values()].find((b) => b.type === "text")!;
  const times: number[] = [];
  for (let i = 0; i < 200; i++) { const a = performance.now(); store.setText(some.id, "typing " + i); times.push(performance.now() - a); }
  times.sort((a, b) => a - b);
  console.log("Taste (Transaktion + SQLite, WAL):", "p50", times[100]!.toFixed(2), "ms · p95", times[190]!.toFixed(2), "ms");
  // Seite öffnen: Teilbaum einer Seite
  const page = [...store.blocks.values()].find((b) => b.type === "page")!;
  t("7 Teilbaum einer Seite (descendants)", () => store.descendants(page.id).length);
  // Lazy-Variante: nur Seiten laden (parent als Spalte simuliert über json_extract-Index)
  db2.exec("CREATE INDEX IF NOT EXISTS bench_type ON records(json_extract(data,'$.type')) WHERE kind='block'");
  db2.exec("CREATE INDEX IF NOT EXISTS bench_parent ON records(json_extract(data,'$.parent')) WHERE kind='block'");
  const pages = t("8 nur Seiten lesen (Index auf type)", () => db2.all("SELECT data FROM records WHERE kind='block' AND json_extract(data,'$.type')='page'"));
  t("9 Seiten JSON.parse + zod", () => pages.map((r) => safeParseRecord({ kind: "block", data: JSON.parse(typeof r.data === "string" ? r.data : dec.decode(r.data as Uint8Array)) })));
  const kids: number[] = [];
  for (let i = 0; i < 50; i++) { const a = performance.now(); db2.all("SELECT data FROM records WHERE kind='block' AND json_extract(data,'$.parent')=?", ["b:" + (pages.length ? JSON.parse(dec.decode(pages[i * 7 % pages.length]!.data as Uint8Array)).id : "")]); kids.push(performance.now() - a); }
  kids.sort((a, b) => a - b);
  console.log("Blöcke einer Seite per Index lesen: p50", kids[25]!.toFixed(2), "ms · p95", kids[47]!.toFixed(2), "ms");
  void canonicalStringify;
}
