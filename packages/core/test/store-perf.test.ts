// Ladezeit des Stores: früher wurde der Kinder-Index pro Record neu sortiert (10.000 Zeilen ≈ 3,3 s).
import { it, expect } from "vitest";
import { MemoryPersistence, WorkspaceStore, type WireRecord } from "../src/index.js";
it("10.000 Zeilen laden und per Sync einspielen bleibt unter 1 s (Kinder-Index sortiert einfügen)", () => {
  const stamp = { millis: 1, counter: 0, node: "x" };
  const recs: WireRecord[] = Array.from({ length: 10000 }, (_, i) => ({ kind: "block", data: { id: "r" + i, type: "page", parent: "d:D", sk: "a" + String(i).padStart(6, "0"), text: "x", createdAt: 0, updatedAt: 0, stamp } }));
  const t = performance.now();
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(recs), node: "n" });
  expect(performance.now() - t).toBeLessThan(1000);
  
  const t2 = performance.now();
  const s2 = new WorkspaceStore({ node: "m" });
  s2.applyRemote(recs);
  expect(performance.now() - t2).toBeLessThan(1000);
  expect(s2.children("d:D").length).toBe(10000);
  
  expect(s.children("d:D").length).toBe(10000);
});

// Feedback 11. 11.: „alles auswählen → in den Papierkorb“ und „Papierkorb leeren“ reagierten in einem echten
// Arbeitsbereich nicht. Die obersten Seiten wurden jeder gegen jeden gesucht (8.000 Seiten ≈ 7,7 s), beim Löschen lief
// jeder Block über alle Ansichten. Jetzt linear.
import { createDatabase, emptyTrash, restorePages, trashPages, trashedPages } from "../src/index.js";
it("8.000 verschachtelte Seiten mit 400 Datenbanken: in den Papierkorb, zurück, wieder hinein und leeren – je unter 1 s", () => {
  const recs: WireRecord[] = [];
  const N = 8000;
  for (let i = 0; i < N; i++) {
    const parent = i % 10 === 0 ? "w" : "b:P" + (i - 1); // Ketten bis Tiefe 9
    recs.push({ kind: "block", data: { id: "P" + i, type: "page", parent, sk: "a" + String(i).padStart(6, "0"), text: "Page " + i, createdAt: 0, updatedAt: 0 } } as WireRecord);
    for (let k = 0; k < 5; k++) recs.push({ kind: "block", data: { id: `P${i}-${k}`, type: "text", parent: "b:P" + i, sk: "a" + k, text: "t", createdAt: 0, updatedAt: 0 } } as WireRecord);
  }
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(recs), node: "n" });
  for (let d = 0; d < N / 20; d++) createDatabase(s, { parent: "w", title: [{ text: "DB" + d }], sampleRows: 3, undoable: false });
  const ids = [...s.blocks.values()].filter((b) => b.type === "page" || b.type === "databasePage").map((b) => b.id);
  const time = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };

  expect(time(() => trashPages(s, ids))).toBeLessThan(1000);
  const roots = trashedPages(s);
  expect(roots).toHaveLength(N / 10 + N / 20); // nur die obersten landen im Papierkorb, der Rest geht mit
  expect(time(() => restorePages(s, roots.map((b) => b.id)))).toBeLessThan(1000);
  expect(trashedPages(s)).toHaveLength(0);
  trashPages(s, ids);
  expect(time(() => emptyTrash(s))).toBeLessThan(1000);
  expect(s.blocks.size).toBe(0);
  expect(s.views.size).toBe(0);
  expect(s.databases.size).toBe(0);
});
