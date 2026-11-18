// BSD-495 (aus ADR 0017, Messung 17.11.): Zeitmessung ins Gate – ein Workspace mit 100 000 Records. Gemessen werden
// der Start (openWorkspace: Zeilen lesen, prüfen, Index aufbauen), der Speicher danach und der erste Sync (alle Records
// kommen vom Server in eine leere Datei). Schwellen lokal hart (CPU-Zeit, bester von drei Versuchen), in der CI nur
// Warnung (packages/core/test/perf-budget.ts). Ausgangswerte im Container 17.11.: siehe Kommentar an den Schwellen.
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { keysBetween, type Block, type WireRecord } from "@based/core";
import { openWorkspace } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import { cpuTime, expectWithinBudget } from "../../core/test/perf-budget.js";

const PAGES = 4_000, PER = 24; // 4 000 Seiten × (1 + 24 Blöcke) = 100 000 Records
const WORDS = "the of and to in is that for it as with was on be by at this have from or one had not but what all were when we there can an your which their said".split(" ");

/** Gleichbleibender Workspace (fester Zufall): Seiten mit Unterseiten, Absätze, Listen, Aufgaben, etwas Formatierung. */
function world(): WireRecord[] {
  let seed = 42;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const text = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ");
  const TYPES = ["text", "text", "text", "bulletedList", "todo", "heading2", "quote"];
  const out: WireRecord[] = [];
  const pk = keysBetween(PAGES, undefined, undefined);
  let millis = 1_793_974_300_000, counter = 0;
  const stamp = () => ({ millis: (millis += 3), counter: counter++ % 300, node: "3C8ED7C0" });
  for (let i = 0; i < PAGES; i++) {
    const pid = `P-${i}`;
    const now = 815_000_000 + i * 60;
    out.push({ kind: "block", data: { id: pid, type: "page", parent: i % 10 === 0 ? "w" : `b:P-${i - (i % 10)}`, sk: pk[i]!, text: text(4), createdAt: now, updatedAt: now, stamp: stamp() } as Block });
    const keys = keysBetween(PER, undefined, undefined);
    for (let j = 0; j < PER; j++) {
      const type = TYPES[Math.floor(rnd() * TYPES.length)]!;
      const b = { id: `B-${i}-${j}`, type, parent: "b:" + pid, sk: keys[j]!, text: rnd() < 0.15 ? [{ t: text(6) }, { t: text(3), m: { b: true } }, { t: text(8) }] : text(6 + Math.floor(rnd() * 24)), createdAt: now + j, updatedAt: now + j, stamp: stamp() } as Block;
      if (type === "todo") b.props = { checked: rnd() < 0.5 };
      out.push({ kind: "block", data: b });
    }
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "based-scale-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Speicher braucht eine echte Bereinigung vor dem Messen; --expose-gc lässt sich auch zur Laufzeit setzen (Worker).
setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const mb = (n: number) => Math.round(n / 1048576);

describe("100 000 Records: Start, Speicher, erster Sync (BSD-495, @perf)", () => {
  const records = world();
  const file = join(dir, "w.sqlite");

  it("erster Sync: 100 000 Records vom Server in eine leere Datei", () => {
    expect(records.length).toBe(100_000);
    let n = 0;
    // Ausgangswert 17.11. (Container): 1,7–1,9 s CPU. Je Versuch eine frische Datei.
    const r = expectWithinBudget("erster Sync 100 000 Records", { sync: 6_000 }, () => {
      const path = join(dir, `sync-${n++}.sqlite`);
      const db = openNodeDatabase(path);
      const { store } = openWorkspace(db, { node: "AAAA" });
      const sync = cpuTime(() => { store.applyRemote(records); });
      expect(store.blocks.size).toBe(100_000);
      db.close();
      return { sync };
    });
    console.info(`BSD-495 erster Sync: ${r.sync.toFixed(0)} ms CPU`);
  }, 120_000);

  it("Start: openWorkspace mit 100 000 Records, Speicher danach", () => {
    const seedDB = openNodeDatabase(file);
    openWorkspace(seedDB, { node: "AAAA" }).store.applyRemote(records);
    seedDB.close();
    let heap = 0;
    // Ausgangswert 17.11. (Container): 1,0–1,1 s CPU, 41 MB Heap. Schwellen mit Luft für langsamere Rechner.
    const r = expectWithinBudget("Start 100 000 Records", { open: 4_000 }, () => {
      gc();
      const h0 = process.memoryUsage().heapUsed;
      const db = openNodeDatabase(file);
      let store: ReturnType<typeof openWorkspace>["store"] | undefined;
      const open = cpuTime(() => { store = openWorkspace(db, { node: "AAAA" }).store; });
      expect(store!.blocks.size).toBe(100_000);
      gc();
      heap = Math.max(heap, process.memoryUsage().heapUsed - h0);
      db.close();
      return { open };
    });
    console.info(`BSD-495 Start: ${r.open.toFixed(0)} ms CPU, Heap nach dem Öffnen ${mb(heap)} MB`);
    expectWithinBudget("Heap nach dem Öffnen (MB)", { heap: 150 }, () => ({ heap: mb(heap) }), 1);
  }, 120_000);

  it("Start nach Bedarf (ADR 0017 Stufe B): nur das Gerüst – ein Bruchteil von Zeit und Speicher", () => {
    // Einmalig: die beiden Indizes anlegen (gehört nicht zum Start, den jeder weitere Start zahlt).
    const first = openNodeDatabase(file);
    const built = cpuTime(() => { openWorkspace(first, { node: "AAAA", lazy: true }); });
    first.close();
    let heap = 0, loaded = 0;
    // Ausgangswert 17.11. (Container): 78 ms CPU, 1 MB Heap, Indizes einmalig 0,6 s (voll geladen: 1,1 s, 41 MB).
    const r = expectWithinBudget("Start nach Bedarf 100 000 Records", { open: 600 }, () => {
      gc();
      const h0 = process.memoryUsage().heapUsed;
      const db = openNodeDatabase(file);
      let store: ReturnType<typeof openWorkspace>["store"] | undefined;
      const open = cpuTime(() => { store = openWorkspace(db, { node: "AAAA", lazy: true }).store; });
      expect(store!.isPartial).toBe(true);
      expect(store!.blocks.size).toBe(100_000);
      loaded = store!.blocks.loadedSize;
      gc();
      heap = Math.max(heap, process.memoryUsage().heapUsed - h0);
      // eine Seite öffnen holt nur ihre Blöcke
      const page = [...store!.skeletonBlocks()][17]!.id;
      expect(store!.descendants(page).length).toBeGreaterThan(0);
      expect(store!.fullLoads).toBe(0);
      db.close();
      return { open };
    });
    expect(loaded).toBeLessThan(5_000);
    console.info(`ADR 0017 B Start nach Bedarf: ${r.open.toFixed(0)} ms CPU (Indizes einmalig ${built.toFixed(0)} ms), ${loaded} Blöcke geladen, Heap ${mb(heap)} MB`);
    expectWithinBudget("Heap nach dem Öffnen nach Bedarf (MB)", { heap: 30 }, () => ({ heap: mb(heap) }), 1);
  }, 120_000);
});
