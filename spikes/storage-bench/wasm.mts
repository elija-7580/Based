import { openWasmDatabase } from "../../packages/sync/src/drivers/wasm.ts";
import { openNodeDatabase } from "../../packages/sync/src/drivers/node.ts";
import { SqlitePersistence } from "../../packages/sync/src/persistence.ts";
import type { WireRecord } from "../../packages/core/src/index.ts";
const N = 100_000;
const src = openNodeDatabase("/tmp/based-bench/w-20000x25.sqlite");
const rows = src.all("SELECT kind, id, data FROM records LIMIT " + N);
const dec = new TextDecoder();
const recs: WireRecord[] = rows.map((r) => ({ kind: "block", data: JSON.parse(dec.decode(r.data as Uint8Array)) }));
src.close();
const t = async <T,>(label: string, f: () => T | Promise<T>): Promise<T> => { const a = performance.now(); const r = await f(); console.log(label.padEnd(52), (performance.now() - a).toFixed(0) + " ms"); return r; };
for (const [name, open] of [["WASM (wie im Browser, ohne OPFS)", () => openWasmDatabase()], ["nativ (node:sqlite, wie Tauri später)", async () => openNodeDatabase()]] as const) {
  console.log("—", name);
  const db = await open();
  const p = new SqlitePersistence(db);
  await t("  100 000 Records schreiben (Batches zu 500)", () => { for (let i = 0; i < N; i += 500) p.write(recs.slice(i, i + 500), [], new Map(), false); });
  await t("  loadAll (lesen + JSON + zod)", () => p.loadAll().length);
  const times: number[] = [];
  for (let i = 0; i < 300; i++) { const a = performance.now(); p.write([recs[i]!], [], new Map(), true); times.push(performance.now() - a); }
  times.sort((a, b) => a - b);
  console.log("  ein Record schreiben (eine Taste): p50", times[150]!.toFixed(2), "ms · p95", times[285]!.toFixed(2), "ms");
  db.close();
}
