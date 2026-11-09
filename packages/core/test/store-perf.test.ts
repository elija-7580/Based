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
