// BSD-400 Teil 1 (Kern): Tippen auf großen Seiten – was kostet ein Tastendruck im Editor-Modell? Gemessen wird der
// Befehl, den der Block-Editor je Taste ausführt (blockCommands.replaceText → Store-Transaktion → Beobachter), auf
// einer Seite mit 300 Blöcken, einmal allein und einmal in einem Workspace mit 5 000 weiteren Seiten.
// Gemessen 16.11. (CPU-ms je Taste, 44 Tasten): p50 0,03–0,05, p95 0,16, max 1,1–1,5. Das Tippen in WebKit
// (p95 215–270 ms, BSD-280 Teil 2) liegt also nicht im Modell, sondern in der Oberfläche (Schicht B, E2E).
// Grenzen mit reichlich Luft gegen Rückschritte (z. B. ein Beobachter, der je Taste den ganzen Workspace durchgeht).
import { describe, expect, it } from "vitest";
import { blockCommands as cmd, createPage, MemoryPersistence, plainText, WorkspaceStore, type Block } from "../src/index.js";
import { cpuTime, expectWithinBudget } from "./perf-budget.js";

function bigPage(otherPages: number) {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
  for (let i = 0; i < otherPages; i++) createPage(store, { title: "Page " + i });
  const page = createPage(store, { title: "Big" });
  const now = store.now();
  store.transact("t", (tx) => {
    for (let i = 0; i < 300; i++) {
      tx.put({ kind: "block", data: { id: "b" + i, type: i % 7 === 0 ? "heading2" : "text", parent: "b:" + page, sk: "a" + String(i).padStart(4, "0"), text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit " + i, createdAt: now, updatedAt: now } as Block });
    }
  });
  let notified = 0;
  store.observe(() => { notified++; });
  return { store, notified: () => notified };
}

const TEXT = "the quick brown fox jumps over the lazy dog!";

describe("Tippen im Editor-Modell (BSD-400 Teil 1)", () => {
  for (const others of [0, 5000]) {
    it(`300 Blöcke, ${others} weitere Seiten: je Taste p95 < 4 ms, max < 30 ms (CPU)`, () => {
      const run = () => {
        const { store, notified } = bigPage(others);
        const times: number[] = [];
        let pos = 10;
        for (const ch of TEXT) {
          times.push(cpuTime(() => { cmd.replaceText(store, { blockId: "b150", from: pos, to: pos }, ch); }));
          pos++;
        }
        expect(plainText(store.blocks.get("b150")!.text)).toContain(TEXT);
        expect(notified()).toBe(TEXT.length); // eine Änderung je Taste
        times.sort((a, b) => a - b);
        return { p95: times[Math.floor(times.length * 0.95)]!, max: times[times.length - 1]! };
      };
      const t = expectWithinBudget(`Tippen (300 Blöcke, ${others} Seiten)`, { p95: 4, max: 30 }, run);
      console.info(`Tippen ${others} Seiten (ms CPU):`, { p95: +t.p95.toFixed(2), max: +t.max.toFixed(2) });
    });
  }
});
