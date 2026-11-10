// BSD-171: Store-Verhalten, das die Fixtures nicht direkt abdecken.
import { describe, expect, it } from "vitest";
import { MemoryPersistence, WorkspaceStore, keyOf, type RecordKeyString, type Stamp, type WireRecord } from "../src/index.js";

const block = (id: string, parent: string, sk: string, text = id, type = "text"): WireRecord => ({
  kind: "block",
  data: { id, type, parent, sk, text, createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "x" } },
});

function store(records: WireRecord[] = []) {
  let now = 100;
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n", now: () => now });
  s.clock.wallClock = () => 5000;
  return { s, tick: (sec: number) => (now += sec) };
}

describe("WorkspaceStore", () => {
  it("Kinder nach (sk, id)", () => {
    const { s } = store([block("c", "b:p", "a1"), block("a", "b:p", "a0"), block("b", "b:p", "a1")]);
    expect(s.children("b:p")).toEqual(["a", "b", "c"]);
  });

  it("Ausnahme in der Transaktion rollt alles zurück", () => {
    const { s } = store([block("a", "w", "a0", "alt")]);
    expect(() => s.transact("x", (tx) => {
      tx.update("a", (b) => { b.text = "neu"; });
      throw new Error("kaputt");
    })).toThrow("kaputt");
    expect(s.blocks.get("a")?.text).toBe("alt");
    expect(s.canUndo).toBe(false);
  });

  it("lokale Änderung bekommt neuen Stempel, Bearbeiter und Zeit", () => {
    const { s } = store([block("a", "w", "a0")]);
    s.setText("a", "neu");
    const b = s.blocks.get("a")!;
    expect(b.stamp).toEqual({ millis: 5000, counter: 0, node: "n" });
    expect(b.updatedBy).toBe("me");
    expect(b.updatedAt).toBe(100);
  });

  it("Tippen wird zusammengefasst, nach 1,5 s nicht mehr", () => {
    const { s, tick } = store([block("a", "w", "a0", "0")]);
    s.setText("a", "1");
    s.setText("a", "12");
    tick(2);
    s.setText("a", "123");
    s.undo();
    expect(s.blocks.get("a")?.text).toBe("12");
    s.undo();
    expect(s.blocks.get("a")?.text).toBe("0");
  });

  it("lokale Löschung hinterlässt einen gestempelten Tombstone", () => {
    const p = new MemoryPersistence([block("a", "b:p", "a0")]);
    const s = new WorkspaceStore({ persistence: p, node: "n", now: () => 0 });
    s.clock.wallClock = () => 7000;
    s.deleteBlocks(["a"]);
    expect(s.blocks.has("a")).toBe(false);
    expect(p.tombstone(keyOf("block", "a"))).toEqual({ millis: 7000, counter: 0, node: "n" });
    // ältere Version von woanders bleibt gelöscht
    const r = s.applyRemote([block("a", "b:p", "a0", "alt")]);
    expect(r.tombstoned.get(keyOf("block", "a"))).toBeDefined();
    expect(s.blocks.has("a")).toBe(false);
  });

  it("Seiten in einem gelöschten Block wandern in den Papierkorb (BSD-99)", () => {
    const { s } = store([block("p", "w", "a0", "P", "page"), block("t", "b:p", "a0", "T", "toggle"), block("sub", "b:t", "a0", "S", "page"), block("x", "b:t", "a1")]);
    s.deleteBlocks(["t"]);
    expect(s.blocks.has("t")).toBe(false);
    expect(s.blocks.has("x")).toBe(false);
    expect(s.blocks.get("sub")?.parent).toBe("b:p");
    expect(s.blocks.get("sub")?.trashedAt).toBe(100);
    s.undo();
    expect(s.blocks.get("sub")?.parent).toBe("b:t");
    expect(s.blocks.has("x")).toBe(true);
  });
});

describe("transact mit keepStamps", () => {
  it("übernimmt Stempel unverändert und loggt als lokale Änderung", () => {
    const writes: boolean[] = [];
    class Spy extends MemoryPersistence {
      override write(u: WireRecord[], d: RecordKeyString[], t: Map<RecordKeyString, Stamp>, local?: boolean) {
        writes.push(local === true);
        super.write(u, d, t);
      }
    }
    const p = new Spy();
    const s = new WorkspaceStore({ persistence: p, node: "n" });
    const r = block("a", "w", "a0");
    (r.data as { stamp: unknown }).stamp = { millis: 42, counter: 7, node: "n" };
    s.transact("Edit", (tx) => tx.put(r), { keepStamps: true });
    expect(s.blocks.get("a")?.stamp).toEqual({ millis: 42, counter: 7, node: "n" });
    expect(writes).toEqual([true]);
    expect(s.canUndo).toBe(false);
  });

  it("BSD-220 derived: nicht lokal (kein Push), nicht rückgängig, Herkunft „derived“; mit keepStamps ungestempelt", () => {
    const writes: [boolean, boolean][] = [];
    class Spy extends MemoryPersistence {
      override write(u: WireRecord[], d: RecordKeyString[], t: Map<RecordKeyString, Stamp>, local?: boolean, derived?: boolean) {
        writes.push([local === true, derived === true]);
        super.write(u, d, t);
      }
    }
    const s = new WorkspaceStore({ persistence: new Spy(), node: "n" });
    const origins: string[] = [];
    s.observe((c) => origins.push(c.origin));
    s.transact("Edit", (tx) => tx.put(block("a", "w", "a0")), { derived: true });
    expect(s.blocks.get("a")?.stamp?.node).toBe("n"); // frisch gestempelt
    const r = block("b", "w", "a1");
    (r.data as { stamp: unknown }).stamp = { millis: 42, counter: 7, node: "x" };
    s.transact("Edit", (tx) => tx.put(r), { derived: true, keepStamps: true });
    expect(s.blocks.get("b")?.stamp).toEqual({ millis: 42, counter: 7, node: "x" });
    expect(writes).toEqual([[false, true], [false, true]]);
    expect(origins).toEqual(["derived", "derived"]);
    expect(s.canUndo).toBe(false);
  });
});
