// BSD-280 Teil 3: Quick Find unter Last – Index über 5 000 Seiten (je 6 Blöcke), eine Seite mit 2 000 Blöcken und
// eine Datenbank mit 20 000 Zeilen; gemessen werden Aufbau, jeder Tastendruck („p“ … „project“, je die langsamste
// Suche), ein Treffer im Fließtext, eine Suche ohne Treffer und eine Änderung + erneute Suche. CPU-Zeit, lokal hart,
// in der CI Warnung (perf-budget.ts). Grenzen: drei Läufe auf der 4-Kern-Maschine, mit mindestens doppelter Luft.
// Gemessen 14.11. (CPU-ms): Aufbau 310–380, Tastendruck vorher 110–120 („p“), nach Ausschnitt-erst-am-Ende und
// Wortanfang ohne split 78–92, Volltext 9–21, kein Treffer 11–22, Änderung + Suche 11–22.
import { describe, expect, it } from "vitest";
import { cpuTime, expectWithinBudget } from "./perf-budget.js";
import { ImportFiles, importNotionItems, MemoryPersistence, SearchIndex, WorkspaceStore, pv, type WireRecord } from "../src/index.js";
import { bigWorld } from "./fixtures/hybrid-world.js";

const stamp = { millis: 1, counter: 0, node: "x" };
const WORDS = ["alpha", "budget", "meeting", "roadmap", "project", "launch", "design", "notes", "review", "travel"];

function workspace(): WireRecord[] {
  const out: WireRecord[] = [];
  const block = (id: string, type: string, parent: string, sk: string, text: string): WireRecord =>
    ({ kind: "block", data: { id, type, parent, sk, text, createdAt: 0, updatedAt: 0, stamp } } as WireRecord);
  for (let i = 0; i < 5000; i++) {
    const w = WORDS[i % WORDS.length]!;
    out.push(block("p" + i, "page", "w", "a" + String(i).padStart(5, "0"), `${w[0]!.toUpperCase()}${w.slice(1)} page ${i}`));
    for (let j = 0; j < 6; j++) out.push(block(`p${i}b${j}`, "text", "b:p" + i, "a" + j, `Paragraph ${j} about ${WORDS[(i + j) % WORDS.length]} and other things number ${i * 6 + j}`));
  }
  out.push(block("big", "page", "w", "z0", "Big page"));
  for (let j = 0; j < 2000; j++) out.push(block("bigb" + j, "text", "b:big", "a" + String(j).padStart(4, "0"), `Line ${j} of the long page with ${WORDS[j % WORDS.length]} inside`));
  out.push({ kind: "block", data: { id: "dbblk", type: "databasePage", parent: "w", sk: "z1", props: { databaseID: "db" }, createdAt: 0, updatedAt: 0, stamp } } as WireRecord);
  out.push({ kind: "database", data: { id: "db", blockID: "dbblk", title: "Tasks", createdAt: 0, updatedAt: 0, stamp,
    properties: [{ id: "title", name: "Name", type: "title" }, { id: "note", name: "Note", type: "text" }] } } as WireRecord);
  for (let r = 0; r < 20_000; r++) {
    out.push({ kind: "block", data: { id: "r" + r, type: "page", parent: "d:db", sk: "a" + String(r).padStart(6, "0"), text: `Task ${r} ${WORDS[r % WORDS.length]}`,
      values: { note: pv("text", "note " + (r % 97)) }, createdAt: r, updatedAt: r, stamp } } as WireRecord);
  }
  return out;
}

describe("Quick Find (BSD-280)", () => {
  // BSD-425: Quick Find sucht erweitert (verteilte Begriffe, Optionen, Tippfehler) – gemessen wird, was die App ruft.
  it("Aufbau, Tastendruck, Volltext, kein Treffer, Änderung + Suche", () => {
    const QF = { limit: 30, extended: true } as const;
    const records = workspace();
    const perKey: number[] = [];
    const run = () => {
      let index!: SearchIndex;
      const build = cpuTime(() => { index = SearchIndex.fromRecords(records); });
      let keystroke = 0;
      perKey.length = 0;
      const typed = "project";
      for (let n = 1; n <= typed.length; n++) {
        const q = typed.slice(0, n);
        let hits = 0;
        const ms = cpuTime(() => { hits = index.run(q, QF)?.length ?? 0; });
        perKey.push(Math.round(ms));
        keystroke = Math.max(keystroke, ms);
        expect(hits).toBeGreaterThan(0);
      }
      let deep = 0;
      const body = cpuTime(() => { deep = index.run("other things number 29999", QF)?.length ?? 0; });
      expect(deep).toBeGreaterThan(0);
      const miss = cpuTime(() => { expect(index.run("zzqx", QF)).toEqual([]); });
      // Tippfehler: die genaue Suche findet nichts, dann das Wörterbuch und ein weiterer Durchlauf (teuerster Weg).
      let typoHits = 0;
      const typo = cpuTime(() => { typoHits = index.run("roadmpa laucnh", QF)?.length ?? 0; });
      expect(typoHits).toBeGreaterThan(0);
      const edit = cpuTime(() => {
        index.apply({ upserts: [{ kind: "block", data: { id: "p7b0", type: "text", parent: "b:p7", sk: "a0", text: "Quokka sighting", createdAt: 0, updatedAt: 1, stamp: { ...stamp, millis: 2 } } } as WireRecord], deletions: [] });
        expect(index.run("quokka", QF)?.[0]?.pageID).toBe("p7");
      });
      return { build, keystroke, body, miss, typo, edit };
    };
    const t = expectWithinBudget("Quick Find", { build: 1000, keystroke: 200, body: 60, miss: 60, typo: 250, edit: 60 }, run);
    console.info("Quick Find (ms CPU):", Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)])), "je Taste:", perKey.join(" "));
  }, 90_000); // BSD-572: 5 000 Seiten + bis zu drei Durchgänge; unter Last über 20 s (Vitest-Standard)

  it("Wortanfang-Stufe bleibt gleich: Wortgrenze, Bindestrich, Ziffern, Zeichen außerhalb der BMP", () => {
    const idx = SearchIndex.fromRecords([
      ["a", "Pre-launch plan"], ["b", "Relaunch plan"], ["c", "Q3 2026 launch"], ["d", "𝒜launch"], ["e", "😀launch"],
    ].map(([id, text], i) => ({ kind: "block", data: { id, type: "page", parent: "w", sk: "a" + i, text, createdAt: 0, updatedAt: 0, stamp } } as WireRecord)));
    const score = (q: string) => Object.fromEntries((idx.run(q, { now: 0 }) ?? []).map((h) => [h.pageID, Math.round(h.score)]));
    expect(score("launch")).toEqual({ a: 70, b: 55, c: 70, d: 55, e: 70 });
    expect(score("pre-launch")).toEqual({ a: 90 });
    expect(score("2026 lau")).toEqual({ c: 70 });
  });

  it("nur die besten Kandidaten sortieren ändert nichts am Ergebnis (Gleichstände an der Grenze)", () => {
    const recs = Array.from({ length: 600 }, (_, i) => ({ kind: "block", data: {
      id: "q" + String(i).padStart(3, "0"), type: "page", parent: "w", sk: "a" + i, text: i % 7 === 0 ? "item" : `Item ${i % 50} notes`,
      createdAt: 0, updatedAt: -86_400 * 3 * (i % 11), stamp } } as WireRecord));
    const idx = SearchIndex.fromRecords(recs);
    const full = idx.run("item", { limit: 1000, now: 0 })!;
    for (const limit of [1, 5, 30, 100]) expect(idx.run("item", { limit, now: 0 })).toEqual(full.slice(0, limit));
  });

  // BSD-280 Teil 5: dieselbe Messung gegen einen Notion-Import statt gebauter Records – ein HTML-Export-ZIP (wie aus
  // Notion: 5 000 Seiten, ~80 % Datenbankzeilen in 10 Datenbanken, Baum Area → Topic → Note, je 8 Absätze) wird über
  // importNotionItems in einen Store geschrieben; der Index entsteht aus dessen Records (so wie der Worker ihn baut).
  // Gemessen 15.11. (CPU-ms, 4 Kerne, Last ~10, 23 600 Records): Aufbau ~230, langsamste Taste ~85 („row“), Volltext ~6,
  // kein Treffer ~16; 16.11.: Aufbau 255, langsamste Taste 59 („row“), Volltext 10, kein Treffer 7 – gleiche Grenzen wie oben
  // (mindestens doppelte Luft).
  it("Notion-Import (HTML-Export, 5 000 Seiten): Aufbau, Tastendruck, Volltext, kein Treffer", () => {
    const QF = { limit: 30, extended: true } as const;
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "qf" });
    const report = importNotionItems(store, [{ files: new ImportFiles([["Export.zip", bigWorld(5000).zip()]]), path: "Export.zip" }]);
    expect(report.pages + report.rows).toBeGreaterThan(4000);
    const records = store.allRecords();
    const perKey: number[] = [];
    const run = () => {
      let index!: SearchIndex;
      const build = cpuTime(() => { index = SearchIndex.fromRecords(records); });
      let keystroke = 0;
      perKey.length = 0;
      for (const q of ["r", "ro", "row", "row 7", "row 7.1", "t", "to", "top", "topic"]) {
        let hits = 0;
        const ms = cpuTime(() => { hits = index.run(q, QF)?.length ?? 0; });
        perKey.push(Math.round(ms));
        keystroke = Math.max(keystroke, ms);
        expect(hits, q).toBeGreaterThan(0);
      }
      let deep: { pageID: string }[] = [];
      const body = cpuTime(() => { deep = index.run("paragraph 3 of page 123", QF) ?? []; });
      expect(deep.length).toBeGreaterThan(0);
      const miss = cpuTime(() => { expect(index.run("zzqx", QF)).toEqual([]); });
      return { build, keystroke, body, miss };
    };
    const t = expectWithinBudget("Quick Find (Notion-Import)", { build: 1000, keystroke: 200, body: 60, miss: 60 }, run);
    console.info("Quick Find Notion-Import (ms CPU):", Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)])), "je Taste:", perKey.join(" "), "Records:", records.length);
  }, 90_000); // BSD-572: Import + bis zu drei Durchgänge; allein ~8 s, unter Last über 20 s (Vitest-Standard)
});
