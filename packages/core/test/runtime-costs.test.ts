// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// Laufzeit-Analyse 20.11.2026: Stellen, die bei großen Workspaces (20 000 Seiten, 100 000 Zeilen) unnötig Rechenzeit
// kosteten. Je Stelle: dasselbe Ergebnis wie vorher, und der teure Weg wird nicht mehr gegangen.
import { describe, expect, it } from "vitest";
import { buildOutline, buildOutlineByWalk, keysBetween, MemoryPersistence, SearchIndex, structureSignature, WorkspaceStore, type Block } from "../src/index.js";
import { firstK } from "../src/search/search.js";
import { cpuTime, expectWithinBudget } from "./perf-budget.js";

const T = 800_000_000;
const stamp = { millis: 1, counter: 0, node: "t" };
const blk = (id: string, parent: string, sk: string, type = "text", extra: Partial<Block> = {}): Block =>
  ({ id, type, parent, sk, createdAt: T, updatedAt: T, stamp, ...extra }) as Block;

/** Kleiner deterministischer Zufall (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Seitenleiste: Datenbankzeilen ändern die Gliederung nicht", () => {
  it("Zeile außerhalb des Papierkorbs hat keine Signatur; im Papierkorb schon (Papierkorb-Liste)", () => {
    const row = blk("R1", "d:DB", "a0", "page", { text: "Row" });
    expect(structureSignature(row)).toBe("");
    expect(structureSignature({ ...row, sk: "b0", props: { icon: "🙂" } })).toBe("");
    expect(structureSignature({ ...row, trashedAt: T })).not.toBe("");
    // eine Seite behält ihre volle Signatur
    const page = blk("P1", "w", "a0", "page", { text: "Page" });
    expect(structureSignature(page)).not.toBe(structureSignature({ ...page, sk: "b0" }));
  });

  it("Gliederung über das Gerüst = Gliederung über alle Blöcke, auch mit Zeilen und Papierkorb", () => {
    const store = new WorkspaceStore({ node: "N1" });
    store.transact("seed", (tx) => {
      tx.put({ kind: "block", data: blk("P1", "w", "a0", "page", { text: "One" }) });
      tx.put({ kind: "block", data: blk("P2", "b:P1", "a0", "page", { text: "Two" }) });
      tx.put({ kind: "block", data: blk("T1", "b:P1", "a1", "toggle") });
      tx.put({ kind: "block", data: blk("P3", "b:T1", "a0", "page", { text: "In toggle" }) });
      tx.put({ kind: "block", data: blk("DBP", "w", "a1", "databasePage", { props: { databaseID: "DB" } }) });
      tx.put({ kind: "database", data: { id: "DB", blockID: "DBP", title: "Tasks", properties: [], createdAt: T, updatedAt: T, stamp } as never });
      tx.put({ kind: "block", data: blk("R1", "d:DB", "a0", "page", { text: "Row 1" }) });
      tx.put({ kind: "block", data: blk("R2", "d:DB", "a1", "page", { text: "Row 2", trashedAt: T }) });
      tx.put({ kind: "block", data: blk("P4", "w", "a2", "page", { text: "Gone", trashedAt: T + 5 }) });
    }, { undoable: false });
    const o = buildOutline(store);
    expect(o).toEqual(buildOutlineByWalk(store));
    expect(o.trash.map((t) => t.id)).toEqual(["P4", "R2"]);
    expect(o.nodes.R1).toBeUndefined();
  });
});

describe("Quick Find: nur die ersten Treffer auswählen statt alle zu sortieren", () => {
  it("firstK = sortieren und abschneiden (strenge Ordnung)", () => {
    const rand = rng(7);
    for (let n = 0; n < 200; n++) {
      const items = Array.from({ length: Math.floor(rand() * 300) }, (_, i) => ({ id: i, score: Math.floor(rand() * 5) }));
      const cmp = (a: { id: number; score: number }, b: { id: number; score: number }) => b.score - a.score || a.id - b.id;
      const k = Math.floor(rand() * 40);
      expect(firstK(items, k, cmp)).toEqual([...items].sort(cmp).slice(0, k));
    }
  });

  it("Ergebnis mit kleinem Limit = Anfang des Ergebnisses ohne Limit (alle Sortierungen)", () => {
    const store = new WorkspaceStore({ node: "N2" });
    const rand = rng(11);
    const words = ["plan", "budget", "travel", "notes", "meeting", "draft", "review", "ideas"];
    const keys = keysBetween(1500, undefined, undefined);
    store.transact("seed", (tx) => {
      for (let i = 0; i < 1500; i++) {
        const w = words[Math.floor(rand() * words.length)]!;
        const t = T + Math.floor(rand() * 10) * 86_400;
        tx.put({ kind: "block", data: blk(`P${i}`, "w", keys[i]!, "page", { text: `${w} ${i % 7}`, updatedAt: t, createdAt: t - 100 }) });
        tx.put({ kind: "block", data: blk(`B${i}`, `b:P${i}`, "a0", "text", { text: `${words[(i * 3) % words.length]} and ${w}` }) });
      }
    }, { undoable: false });
    const idx = SearchIndex.fromSource(store);
    const strip = (hs: { pageID: string; score: number; blockID?: string; snippet?: string }[] | undefined) => (hs ?? []).map((h) => [h.pageID, h.score, h.blockID, h.snippet]);
    for (const q of ["plan", "p", "notes 3", "and", "travel and", "e"]) {
      for (const sort of ["bestMatch", "lastEditedNewest", "lastEditedOldest", "createdNewest", "createdOldest"] as const) {
        for (const filters of [{}, { titleOnly: true }]) {
          const small = idx.run(q, { limit: 30, sort, filters, now: T });
          const all = idx.run(q, { limit: 1_000_000, sort, filters, now: T });
          expect(strip(small)).toEqual(strip(all?.slice(0, 30)));
        }
      }
    }
  });
});

describe("Store: Entfernen aus einer langen Geschwisterliste ist nicht linear je Block", () => {
  it("zufällig löschen und umsortieren hält die Reihenfolge richtig", () => {
    const store = new WorkspaceStore({ node: "N3", persistence: new MemoryPersistence() });
    const n = 3000;
    const keys = keysBetween(n, undefined, undefined);
    store.transact("seed", (tx) => { for (let i = 0; i < n; i++) tx.put({ kind: "block", data: blk(`R${i}`, "d:DB", keys[i]!, "page") }); }, { undoable: false });
    const rand = rng(3);
    const ids = store.children("d:DB").slice();
    // ein Viertel zufällig löschen, ein Viertel zufällig umsortieren (auch auf gleiche Schlüssel: dann nach ID)
    const del = ids.filter(() => rand() < 0.25);
    const mov = ids.filter((id) => !del.includes(id) && rand() < 0.33);
    store.transact("delete", (tx) => { for (const id of del) tx.remove(`block:${id}`); }, { undoable: false });
    store.transact("move", (tx) => { for (const id of mov) tx.update(id, (b) => { b.sk = keys[Math.floor(rand() * n)]!; }); }, { undoable: false });
    const expected = [...store.blocks.values()].filter((b) => b.parent === "d:DB")
      .sort((a, b) => (a.sk !== b.sk ? (a.sk < b.sk ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((b) => b.id);
    expect(store.children("d:DB")).toEqual(expected);
    // rückgängig und wieder her: Reihenfolge wie vorher
    store.undo();
    store.redo();
    expect(store.children("d:DB")).toEqual(expected);
  });

  it("20 000 von 40 000 Zeilen in zufälliger Reihenfolge löschen (vorher ~0,8 s, jetzt ~0,35 s auf dem Container)", () => {
    const n = 40_000;
    const keys = keysBetween(n, undefined, undefined);
    expectWithinBudget("delete 20k of 40k rows", { ms: 700 }, () => {
      const store = new WorkspaceStore({ node: "N4", persistence: new MemoryPersistence() });
      store.transact("seed", (tx) => { for (let i = 0; i < n; i++) tx.put({ kind: "block", data: blk(`R${i}`, "d:DB", keys[i]!, "page") }); }, { undoable: false });
      const rand = rng(5);
      const ids = store.children("d:DB").filter(() => rand() < 0.5);
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ids[i], ids[j]] = [ids[j]!, ids[i]!]; }
      const ms = cpuTime(() => store.transact("delete", (tx) => { for (const id of ids) tx.remove(`block:${id}`); }, { undoable: false }));
      expect(store.children("d:DB").length).toBe(n - ids.length);
      return { ms };
    });
  });
});
