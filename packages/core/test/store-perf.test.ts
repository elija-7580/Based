// Ladezeit des Stores: früher wurde der Kinder-Index pro Record neu sortiert (10.000 Zeilen ≈ 3,3 s).
import { it, expect } from "vitest";
import { MemoryPersistence, WorkspaceStore, type WireRecord } from "../src/index.js";
import { createDatabase, emptyTrash, restorePages, trashPages, trashedPages } from "../src/index.js";
import { cpuTime as time, expectWithinBudget } from "./perf-budget.js";

it("10.000 Zeilen laden und per Sync einspielen bleibt unter 1 s (Kinder-Index sortiert einfügen)", () => {
  const stamp = { millis: 1, counter: 0, node: "x" };
  const recs: WireRecord[] = Array.from({ length: 10000 }, (_, i) => ({ kind: "block", data: { id: "r" + i, type: "page", parent: "d:D", sk: "a" + String(i).padStart(6, "0"), text: "x", createdAt: 0, updatedAt: 0, stamp } }));
  expectWithinBudget("10.000 Zeilen", { load: 1000, sync: 1000 }, () => {
    let s!: WorkspaceStore;
    const load = time(() => { s = new WorkspaceStore({ persistence: new MemoryPersistence(recs), node: "n" }); });
    expect(s.children("d:D").length).toBe(10000);
    const s2 = new WorkspaceStore({ node: "m" });
    const sync = time(() => s2.applyRemote(recs));
    expect(s2.children("d:D").length).toBe(10000);
    return { load, sync };
  });
});

// Feedback 11. 11.: „alles auswählen → in den Papierkorb“ und „Papierkorb leeren“ reagierten in einem echten
// Arbeitsbereich nicht. Die obersten Seiten wurden jeder gegen jeden gesucht (8.000 Seiten ≈ 7,7 s), beim Löschen lief
// jeder Block über alle Ansichten. Jetzt linear.
// BSD-322: „zurück“ lag allein bei ~1 s (unter `pnpm -r test` darüber): jeder nur neu gestempelte Record wurde beim
// Commit als Text mit seinem Vorher verglichen und tief kopiert. Jetzt ~0,4 s (Vergleich per Referenz, flache Kopie).
it("8.000 verschachtelte Seiten mit 400 Datenbanken: in den Papierkorb, zurück, wieder hinein und leeren – je unter 1 s", () => {
  const N = 8000;
  const recs: WireRecord[] = [];
  for (let i = 0; i < N; i++) {
    const parent = i % 10 === 0 ? "w" : "b:P" + (i - 1); // Ketten bis Tiefe 9
    recs.push({ kind: "block", data: { id: "P" + i, type: "page", parent, sk: "a" + String(i).padStart(6, "0"), text: "Page " + i, createdAt: 0, updatedAt: 0 } } as WireRecord);
    for (let k = 0; k < 5; k++) recs.push({ kind: "block", data: { id: `P${i}-${k}`, type: "text", parent: "b:P" + i, sk: "a" + k, text: "t", createdAt: 0, updatedAt: 0 } } as WireRecord);
  }
  expectWithinBudget("8.000 Seiten", { trash: 1000, restore: 1000, empty: 1000 }, () => {
    const s = new WorkspaceStore({ persistence: new MemoryPersistence(recs), node: "n" });
    for (let d = 0; d < N / 20; d++) createDatabase(s, { parent: "w", title: [{ text: "DB" + d }], sampleRows: 3, undoable: false });
    const ids = [...s.blocks.values()].filter((b) => b.type === "page" || b.type === "databasePage").map((b) => b.id);
    const trash = time(() => trashPages(s, ids));
    const roots = trashedPages(s);
    expect(roots).toHaveLength(N / 10 + N / 20); // nur die obersten landen im Papierkorb, der Rest geht mit
    const restore = time(() => restorePages(s, roots.map((b) => b.id)));
    expect(trashedPages(s)).toHaveLength(0);
    trashPages(s, ids);
    const empty = time(() => emptyTrash(s));
    expect(s.blocks.size).toBe(0);
    expect(s.views.size).toBe(0);
    expect(s.databases.size).toBe(0);
    return { trash, restore, empty };
  });
});

// BSD-322: Die schnelle Prüfung „unverändert“ (gleiches Objekt) darf keine echte Änderung verschlucken, und neu
// gestempelte Records müssen im Store und auf der Platte den neuen Stempel tragen, ohne das Vorher (Undo) zu ändern.
it("Wiederherstellen stempelt den Teilbaum neu, ändert nichts sonst, und Undo bringt den Papierkorb zurück", () => {
  const recs: WireRecord[] = [
    { kind: "block", data: { id: "A", type: "page", parent: "w", sk: "a", text: "A", createdAt: 0, updatedAt: 0, props: { icon: { emoji: "x" } } } } as WireRecord,
    { kind: "block", data: { id: "A1", type: "text", parent: "b:A", sk: "a", text: "eins", createdAt: 0, updatedAt: 0 } } as WireRecord,
  ];
  const p = new MemoryPersistence(recs);
  const s = new WorkspaceStore({ persistence: p, node: "n" });
  trashPages(s, ["A"]);
  const child = s.blocks.get("A1")!;
  const before = structuredClone(child);
  restorePages(s, ["A"]);
  const after = s.blocks.get("A1")!;
  expect(after).not.toBe(child); // neues Objekt, das alte (im Undo-Schritt) bleibt wie es war
  expect(child).toEqual(before);
  expect(after.stamp).toBeDefined();
  expect(after.stamp).not.toEqual(before.stamp);
  expect({ ...after, stamp: undefined }).toEqual({ ...before, stamp: undefined });
  expect(s.blocks.get("A")!.trashedAt).toBeUndefined();
  expect(s.blocks.get("A")!.props).toEqual({ icon: { emoji: "x" } });
  const disk = new Map(p.loadAll().map((r) => [r.data.id as string, r]));
  expect((disk.get("A1")!.data as { stamp?: unknown }).stamp).toEqual(after.stamp);
  expect((disk.get("A")!.data as { trashedAt?: number }).trashedAt).toBeUndefined();
  s.undo();
  expect(s.blocks.get("A")!.trashedAt).toBeDefined();
  expect(s.blocks.get("A1")).toMatchObject({ parent: "b:A", sk: "a", text: "eins" });
});
