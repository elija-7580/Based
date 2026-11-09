// BSD-73: Versionsverlauf – was über das Swift-Verhalten (fixtures/history) hinausgeht: Wiederherstellen verschiebt
// statt zu löschen (Kopie für Blöcke auf anderen Seiten, Inline-Datenbank in den Papierkorb), Schreibfehler
// werden gemeldet statt geschluckt, fehlende Objekte beim Lesen, Kompression, forget.
import { describe, expect, it } from "vitest";
import {
  compressObject, createDatabase, decompressObject, MemoryHistoryStorage, MemoryPersistence, plainText, restoreVersion, versionBlocks,
  VersionHistory, WorkspaceStore, type WireRecord,
} from "../src/index.js";

const blk = (id: string, parent: string, sk: string, type = "text", text = id): WireRecord => ({
  kind: "block",
  data: { id, type, parent, sk, text, createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "x" } },
});

function make() {
  let now = 1000;
  const s = new WorkspaceStore({
    persistence: new MemoryPersistence([
      blk("A", "w", "a0", "page", "Seite A"), blk("a1", "b:A", "a0"), blk("a2", "b:A", "a1"), blk("a2x", "b:a2", "a0"),
      blk("B", "w", "a1", "page", "Seite B"), blk("b1", "b:B", "a0"),
    ]),
    node: "n",
    now: () => (now += 1),
  });
  return s;
}

describe("Wiederherstellen verschiebt statt löscht", () => {
  it("Block, der inzwischen auf einer anderen Seite steht, bleibt dort; die Version bekommt eine Kopie", () => {
    const s = make();
    const version = structuredClone(versionBlocks(s, "A"));
    s.transact("Verschieben", (tx) => tx.update("a2", (b) => { b.parent = "b:B"; b.sk = "a5"; }));
    let n = 0;
    const r = restoreVersion(s, "A", version, { newID: () => `copy-${++n}` })!;
    // a2 und sein Kind stehen weiter auf B …
    expect(s.blocks.get("a2")?.parent).toBe("b:B");
    expect(s.blocks.get("a2x")?.parent).toBe("b:a2");
    // … und A hat eine Kopie von a2 mit dem Kind darunter (das Kind war mitgezogen, also auch kopiert)
    expect(r.copied).toEqual({ a2: "copy-1", a2x: "copy-2" });
    expect(versionBlocks(s, "A").map((b) => [b.id, b.parent, plainText(b.text)])).toEqual([
      ["A", "w", "Seite A"], ["a1", "b:A", "a1"], ["copy-1", "b:A", "a2"], ["copy-2", "b:copy-1", "a2x"],
    ]);
    // ein Undo-Schritt
    expect(s.undo().name).toBe("Restore version");
    expect(s.blocks.has("copy-1")).toBe(false);
    expect(s.blocks.get("a2")?.parent).toBe("b:B");
  });

  it("seitdem hinzugekommene eigene Inline-Datenbank kommt in den Papierkorb, Zeilen bleiben", () => {
    const s = make();
    const version = structuredClone(versionBlocks(s, "A"));
    const db = createDatabase(s, { parent: "b:A", inline: true, sampleRows: 2 });
    const rows = [...s.blocks.values()].filter((b) => b.parent === "d:" + db.databaseID).length;
    const r = restoreVersion(s, "A", version)!;
    expect(r.trashed).toEqual([db.blockID]);
    expect(s.blocks.get(db.blockID)?.trashedAt).toBeDefined();
    expect(s.databases.has(db.databaseID)).toBe(true);
    expect([...s.blocks.values()].filter((b) => b.parent === "d:" + db.databaseID).length).toBe(rows);
    expect(versionBlocks(s, "A").map((b) => b.id)).toEqual(["A", "a1", "a2", "a2x"]);
  });

  it("die aktuelle Fassung bleibt als Version erhalten (Ablauf wie in der Shell)", () => {
    const s = make();
    const h = new VersionHistory(new MemoryHistoryStorage());
    const v1 = h.record("A", versionBlocks(s, "A"), "Seite A", "opened", 100)!;
    s.setText("a1", "neuer Text");
    s.transact("neu", (tx) => tx.put({ kind: "block", data: { id: "a3", type: "text", parent: "b:A", sk: "a9", text: "dazu", createdAt: 0, updatedAt: 0 } }));
    h.record("A", versionBlocks(s, "A"), "Seite A", "before restore", 200);
    restoreVersion(s, "A", h.blocksOf(v1).blocks);
    h.record("A", versionBlocks(s, "A"), "Seite A", "restored", 201);
    expect(plainText(s.blocks.get("a1")?.text)).toBe("a1");
    expect(s.blocks.has("a3")).toBe(false);
    const [restored, before] = h.versions("A");
    expect(restored!.reason).toBe("restored");
    expect(restored!.manifest).not.toBe(v1.manifest); // Stempel/Zeiten sind neu, der Inhalt der alte
    const kept = h.blocksOf(before!).blocks;
    expect(kept.map((b) => [b.id, plainText(b.text)])).toContainEqual(["a3", "dazu"]);
    expect(kept.map((b) => [b.id, plainText(b.text)])).toContainEqual(["a1", "neuer Text"]);
  });
});

describe("VersionHistory", () => {
  it("Schreibfehler wird gemeldet; der Hash gilt danach nicht als gespeichert", () => {
    const s = make();
    const storage = new MemoryHistoryStorage();
    const h = new VersionHistory(storage);
    storage.failNextPut = new Error("disk full");
    expect(() => h.record("A", versionBlocks(s, "A"), "Seite A")).toThrow("disk full");
    expect(storage.stats()).toEqual({ versions: 0, objects: 0, bytes: 0 });
    const v = h.record("A", versionBlocks(s, "A"), "Seite A")!;
    expect(h.blocksOf(v)).toMatchObject({ missing: [] });
    expect(h.blocksOf(v).blocks.map((b) => b.id)).toEqual(["A", "a1", "a2", "a2x"]);
  });

  it("fehlende Objekte meldet blocksOf statt still weniger zu liefern", () => {
    const s = make();
    const storage = new MemoryHistoryStorage();
    const h = new VersionHistory(storage);
    const v = h.record("A", versionBlocks(s, "A"), "Seite A")!;
    const victim = [...storage.objects.keys()].find((k) => k !== v.manifest)!;
    storage.objects.delete(victim);
    const r = h.blocksOf(v);
    expect(r.missing).toEqual([victim]);
    expect(r.blocks.length).toBe(3);
  });

  it("komprimiert große Objekte (Flag 1 = Deflate) und liest sie zurück", () => {
    const s = make();
    s.setText("a1", "lang ".repeat(200));
    const storage = new MemoryHistoryStorage();
    const h = new VersionHistory(storage);
    const v = h.record("A", versionBlocks(s, "A"), "Seite A")!;
    const flags = [...storage.objects.values()].map((o) => o[0]);
    expect(flags).toContain(1);
    expect(compressObject(new TextEncoder().encode("kurz"))[0]).toBe(0);
    expect(plainText(h.blocksOf(v).blocks[1]!.text)).toBe("lang ".repeat(200));
    expect(decompressObject(new Uint8Array([7, 1]))).toBeUndefined();
  });

  it("forget entfernt die Versionen einer Seite, collectGarbage die Objekte", () => {
    const s = make();
    const h = new VersionHistory(new MemoryHistoryStorage());
    h.record("A", versionBlocks(s, "A"), "Seite A");
    h.record("B", versionBlocks(s, "B"), "Seite B");
    h.forget("A");
    expect(h.versions("A")).toEqual([]);
    expect(h.collectGarbage()).toBe(5); // 4 Blöcke + Manifest von A
    expect(h.versions("B").length).toBe(1);
  });
});
