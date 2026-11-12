// BSD-317: Laufzeit-Benchmark mit simulierten 20.000 Seiten (≈80 % Datenbankzeilen). Die API ist eine Attrappe ohne
// Wartezeit; gezählt werden die Anfragen. Notions Limit sind ~3 Anfragen/s – daraus ergibt sich die Netz-Zeit eines
// echten Laufs. Gemessen wird die Rechenzeit (ZIP lesen, HTML übersetzen, schreiben) auf dieser Maschine.
import { describe, expect, it } from "vitest";
import { HybridNotionImport, MemoryHybridState, MemoryPersistence, NotionClient, WorkspaceStore, hybridPending, openNotionExport, storeHybridTarget } from "../src/index.js";
import { bigWorld } from "./fixtures/hybrid-world.js";

const PAGES = Number(process.env.BASED_HYBRID_BENCH_PAGES ?? 20_000);
const RPS = 3;

describe("Notion-Hybrid-Import: Laufzeit (BSD-317)", () => {
  it(`${PAGES} Seiten: Struktur in Minuten, alles unter einer Stunde`, async () => {
    const w = bigWorld(PAGES);
    const zip = w.zip();
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "bench" });
    const client = new NotionClient("secret_x", w.transport(), { requestsPerSecond: 0 });
    const t0 = performance.now();
    const index = openNotionExport(zip);
    const tIndex = performance.now() - t0;
    const imp = new HybridNotionImport(client, index, storeHybridTarget(store, new MemoryHybridState()), undefined, {});
    let structureMs = 0, structureRequests = 0;
    const t1 = performance.now();
    imp.onProgress = (p) => { if (p.phase === "structure" && p.fraction === 1) { structureMs = performance.now() - t1; structureRequests = client.requestCount; } };
    const r = await imp.run("full");
    const totalMs = performance.now() - t1;
    const contentMs = totalMs - structureMs;
    const min = (ms: number) => (ms / 60_000).toFixed(1);
    const netStructure = (structureRequests / RPS) * 1000;
    const netTotal = (r.state.requests / RPS) * 1000;
    const apiOnly = PAGES + r.state.totals.pages; // mindestens eine blocks/children-Anfrage je Seite, dazu die Struktur
    console.log([
      `Hybrid-Benchmark, ${w.pages.size} Seiten (${r.state.totals.rows} Zeilen, ${r.state.totals.pages} Seiten, ${r.state.totals.databases} Datenbanken), ZIP ${(zip.length / 1e6).toFixed(1)} MB`,
      `  ZIP-Verzeichnis lesen:        ${tIndex.toFixed(0)} ms`,
      `  Struktur: ${structureRequests} Anfragen → ${min(netStructure)} min bei ${RPS}/s + ${(structureMs / 1000).toFixed(1)} s Rechenzeit  ⇒ arbeitsfähig nach ~${min(netStructure + structureMs)} min`,
      `  Inhalt:   ${r.state.done.fromZip} Seiten aus dem ZIP, ${r.state.done.blocks} Blöcke, ${(contentMs / 1000).toFixed(1)} s Rechenzeit, ${r.state.requests - structureRequests} Anfragen`,
      `  Gesamt:   ${r.state.requests} Anfragen → ~${min(netTotal + totalMs)} min (reiner API-Import: ≥ ${apiOnly + structureRequests} Anfragen → ≥ ${min(((apiOnly + structureRequests) / RPS) * 1000)} min)`,
    ].join("\n"));
    expect(r.remaining).toBe(0);
    expect(hybridPending(store)).toHaveLength(0);
    expect(w.get("children")).toBe(0);
    expect(r.state.done.fromZip).toBe(w.pages.size);
    // Ziel: arbeitsfähig nach wenigen Minuten, gesamt 30–60 min. Die Schranken lassen Luft für langsame CI-Maschinen.
    expect(netStructure + structureMs).toBeLessThan(10 * 60_000);
    expect(netTotal + totalMs).toBeLessThan(30 * 60_000);
  }, 600_000);
});
