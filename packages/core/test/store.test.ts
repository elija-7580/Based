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

  it("atomic: mehrere Transaktionen werden ein Undo-Schritt und ein Commit", () => {
    const { s } = store([block("a", "w", "a0", "alt"), block("b", "w", "a1", "alt")]);
    const changes: number[] = [];
    s.observe((c) => changes.push(c.keys.length));
    s.atomic("Agent", () => {
      s.setText("a", "eins");
      s.transact("zwei", (tx) => tx.update("b", (x) => { x.text = "zwei"; }));
      // Lesen sieht, was die Teile schon geschrieben haben
      expect(s.blocks.get("a")?.text).toBe("eins");
    });
    expect(changes).toEqual([2]);
    expect(s.undo().name).toBe("Agent");
    expect([s.blocks.get("a")?.text, s.blocks.get("b")?.text]).toEqual(["alt", "alt"]);
    expect(s.canUndo).toBe(false);
  });

  it("atomic: wirft der Rumpf, ist nichts geschrieben; ein gefangener Fehler eines Teils dreht nur diesen Teil zurück", () => {
    const { s } = store([block("a", "w", "a0", "alt"), block("b", "w", "a1", "alt")]);
    expect(() => s.atomic("Agent", () => {
      s.setText("a", "neu");
      throw new Error("kaputt");
    })).toThrow("kaputt");
    expect(s.blocks.get("a")?.text).toBe("alt");
    expect(s.canUndo).toBe(false);

    s.atomic("Agent", () => {
      s.setText("a", "eins");
      try {
        s.transact("Teil", (tx) => {
          tx.update("a", (x) => { x.text = "halb"; });
          tx.update("b", (x) => { x.text = "halb"; });
          throw new Error("Zeile falsch");
        });
      } catch { /* der Rest gilt */ }
      expect(s.blocks.get("a")?.text).toBe("eins");
    });
    expect([s.blocks.get("a")?.text, s.blocks.get("b")?.text]).toEqual(["eins", "alt"]);
    s.undo();
    expect(s.blocks.get("a")?.text).toBe("alt");
  });

  it("undoStep nimmt genau einen Schritt zurück, auch wenn danach andere kamen; Fremdes bleibt", () => {
    const { s } = store([block("a", "w", "a0", "alt"), block("b", "w", "a1", "alt")]);
    s.setText("a", "Agent");
    const step = s.lastUndoStep!;
    s.setText("b", "Nutzer");
    expect(s.undoStep(step)).toMatchObject({ name: "Typing", applied: 1, skipped: 0 });
    expect([s.blocks.get("a")?.text, s.blocks.get("b")?.text]).toEqual(["alt", "Nutzer"]);
    // den Schritt gibt es nicht mehr
    expect(s.undoStep(step).name).toBeNull();
    // der Schritt des Nutzers ist weiter der oberste
    s.undo();
    expect(s.blocks.get("b")?.text).toBe("alt");

    s.setText("a", "Agent");
    const again = s.lastUndoStep!;
    s.transact("Nutzer", (tx) => tx.update("a", (x) => { x.text = "vom Nutzer überschrieben"; }), { undoable: false });
    expect(s.undoStep(again)).toMatchObject({ applied: 0, skipped: 1 });
    expect(s.blocks.get("a")?.text).toBe("vom Nutzer überschrieben");
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
