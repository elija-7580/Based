// BSD-296 (Spike): Sync über einen geteilten Ordner (iCloud Drive). Zwei simulierte Geräte, gleichzeitige Änderungen
// an verschiedenen Blöcken, halbe Datei (iCloud lädt noch), Löschung, Konflikt-Kopie, Schalter aus.
import { describe, expect, it } from "vitest";
import { createPage, emptyTrash, MemoryPersistence, renamePage, trashPages, WorkspaceStore } from "@based/core";
import { FolderAssets, FolderSync, MemoryAssetBlobStore, parseSegment, sha256Hex, segmentName, snapshotName, type FolderTarget } from "../src/index.js";

function folder(): FolderTarget & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async list(dir) {
      const out = new Set<string>();
      for (const k of files.keys()) if (k.startsWith(dir + "/")) out.add(k.slice(dir.length + 1).split("/")[0]!);
      return [...out];
    },
    async write(p, d) { files.set(p, d.slice()); },
    async read(p) { const d = files.get(p); if (!d) throw new Error("missing"); return d; },
    async remove(p) { files.delete(p); },
  };
}

const device = (name: string, target: FolderTarget, enabled = true) => {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: name });
  return { store, sync: new FolderSync({ store, target, device: name, enabled }) };
};

describe("Ordner-Sync (BSD-296, Spike)", () => {
  it("zwei Geräte: gleichzeitige Änderungen an verschiedenen Seiten laufen zusammen; Löschung kommt an", async () => {
    const f = folder();
    const a = device("macA", f), b = device("macB", f);
    const p1 = createPage(a.store, { title: "From A" });
    await a.sync.round();
    await b.sync.round();
    expect(b.store.blocks.get(p1)?.text).toBe("From A");
    // gleichzeitig: A benennt p1 um, B legt eine eigene Seite an
    renamePage(a.store, p1, "Renamed on A");
    const p2 = createPage(b.store, { title: "From B" });
    await Promise.all([a.sync.push(), b.sync.push()]);
    await Promise.all([a.sync.pull(), b.sync.pull()]);
    for (const d of [a, b]) {
      expect(d.store.blocks.get(p1)?.text).toBe("Renamed on A");
      expect(d.store.blocks.get(p2)?.text).toBe("From B");
    }
    // Löschung (Papierkorb leeren) auf B kommt bei A an
    trashPages(b.store, [p1]);
    emptyTrash(b.store);
    await b.sync.round();
    await a.sync.round();
    expect(a.store.blocks.has(p1)).toBe(false);
    // was A per Ordner bekam, schreibt A nicht zurück
    const aSegments = [...f.files.keys()].filter((k) => k.startsWith("devices/macA/") && k.endsWith(".jsonl"));
    expect(aSegments).toHaveLength(2);
  });

  it("halbe Datei wird übersprungen und später gelesen; spätere Segmente warten; Konflikt-Kopien und Platzhalter werden ignoriert", async () => {
    const f = folder();
    const a = device("macA", f), b = device("macB", f);
    const x = createPage(a.store, { title: "One" });
    await a.sync.push();
    createPage(a.store, { title: "Two" });
    await a.sync.push();
    const first = `devices/macA/${segmentName(1)}`;
    const full = f.files.get(first)!;
    f.files.set(first, full.slice(0, full.length - 10)); // iCloud lädt noch
    f.files.set(`devices/macA/000000000001 2.jsonl`, full); // Konflikt-Kopie
    f.files.set(`devices/macA/.000000000003.jsonl.icloud`, new Uint8Array([1]));
    const r1 = await b.sync.pull();
    expect(r1.received).toBe(0);
    expect(r1.waiting).toBe(1);
    expect(r1.ignored.sort()).toEqual(["devices/macA/.000000000003.jsonl.icloud", "devices/macA/000000000001 2.jsonl"]);
    expect(b.store.blocks.has(x)).toBe(false);
    f.files.set(first, full); // fertig hochgeladen
    const r2 = await b.sync.pull();
    expect(r2.received).toBeGreaterThanOrEqual(2);
    expect([...b.store.blocks.values()].map((p) => p.text).filter(Boolean).sort()).toEqual(["One", "Two"]);
    expect(b.sync.state().seen.macA).toBe(2);
  });

  it("kaputte oder fremde Segmente sind nie eine Löschung", () => {
    const enc = new TextEncoder();
    expect(parseSegment(enc.encode("x\n"), "a", 1)).toBeUndefined();
    const head = JSON.stringify({ format: "based-folder-sync", v: 1, device: "a", seq: 1, count: 1 });
    expect(parseSegment(enc.encode(`${head}\n{"op":"del","key":"block:x"}\n{"end":true,"count":1}\n`), "a", 1)?.dels).toEqual(["block:x"]);
    expect(parseSegment(enc.encode(`${head}\n{"op":"del","key":"block:x"}\n{"end":true,"count":2}\n`), "a", 1)).toBeUndefined(); // Anzahl falsch
    expect(parseSegment(enc.encode(`${head}\n{"op":"put","record":{"kind":"block"}}\n{"end":true,"count":1}\n`), "a", 1)).toBeUndefined(); // undekodierbar
    expect(parseSegment(enc.encode(`${head}\n{"op":"del","key":"block:x"}\n{"end":true,"count":1}\n`), "b", 1)).toBeUndefined(); // falsches Gerät
    expect(parseSegment(new Uint8Array([0xff, 0xfe, 0x0a]), "a", 1)).toBeUndefined();
  });

  it("Schalter aus: nichts wird geschrieben oder gelesen", async () => {
    const f = folder();
    const a = device("macA", f, false), b = device("macB", f);
    createPage(a.store, { title: "Local only" });
    expect(await a.sync.round()).toEqual({ pushed: 0, received: 0, waiting: 0, ignored: [] });
    expect(f.files.size).toBe(0);
    createPage(b.store, { title: "B" });
    await b.sync.push();
    await a.sync.pull();
    expect([...a.store.blocks.values()].some((p) => p.text === "B")).toBe(false);
    expect(() => new FolderSync({ store: a.store, target: f, device: "../evil" })).toThrow();
  });

  it("BSD-334: Cursor je Gerät; Kompaktierung erst, wenn alle gelesen haben; neues Gerät liest den Schnappschuss", async () => {
    const f = folder();
    const a = device("macA", f), b = device("macB", f);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(createPage(a.store, { title: `Page ${i}` }));
      await a.sync.push();
    }
    renamePage(a.store, ids[0]!, "Renamed");
    await a.sync.push();
    trashPages(a.store, [ids[1]!]);
    emptyTrash(a.store);
    await a.sync.push(); // 7 Segmente
    // B hat noch nichts gelesen (kein cursor.json): nichts wird entfernt
    createPage(b.store, { title: "B" });
    await b.sync.push();
    expect(await a.sync.compact()).toBe(0);
    await b.sync.pull();
    expect(JSON.parse(new TextDecoder().decode(f.files.get("devices/macB/cursor.json")!)).seen).toEqual({ macA: 7 });
    // jetzt darf A: 7 Segmente → 1 Schnappschuss
    expect(await a.sync.compact()).toBe(7);
    const own = [...f.files.keys()].filter((k) => k.startsWith("devices/macA/")).sort();
    expect(own).toEqual([`devices/macA/${snapshotName(7)}`]);
    // ein neues Gerät liest den Schnappschuss und danach weitere Segmente
    const c = device("macC", f);
    renamePage(a.store, ids[2]!, "After compaction");
    await a.sync.push();
    const r = await c.sync.pull();
    expect(r.waiting).toBe(0);
    expect(c.store.blocks.get(ids[0]!)?.text).toBe("Renamed");
    expect(c.store.blocks.has(ids[1]!)).toBe(false);
    expect(c.store.blocks.get(ids[2]!)?.text).toBe("After compaction");
    expect(c.sync.state().seen.macA).toBe(8);
    // B liest weiter wie gewohnt (Segment 8)
    await b.sync.pull();
    expect(b.store.blocks.get(ids[2]!)?.text).toBe("After compaction");
    // C hat jetzt einen Cursor; zweite Kompaktierung fasst Schnappschuss + Segment 8 zusammen
    await b.sync.pull();
    expect(await a.sync.compact()).toBe(2);
    expect([...f.files.keys()].filter((k) => k.startsWith("devices/macA/")).sort()).toEqual([`devices/macA/${snapshotName(8)}`]);
    const d = device("macD", f);
    await d.sync.pull();
    expect(d.store.blocks.get(ids[2]!)?.text).toBe("After compaction");
    expect(d.store.blocks.has(ids[1]!)).toBe(false);
  });

  it("BSD-334: ohne remove am Ziel oder mit unlesbarem eigenen Segment wird nie kompaktiert; round() kompaktiert ab compactAfter", async () => {
    const f = folder();
    const noRemove: FolderTarget = { list: f.list, write: f.write, read: f.read };
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "macA" });
    const a = new FolderSync({ store, target: noRemove, device: "macA", enabled: true });
    for (let i = 0; i < 3; i++) { createPage(store, { title: `P${i}` }); await a.push(); }
    expect(await a.compact()).toBe(0);
    const a2 = new FolderSync({ store, target: f, device: "macA", enabled: true, state: a.state(), compactAfter: 3 });
    const seg = `devices/macA/${segmentName(2)}`;
    const good = f.files.get(seg)!;
    f.files.set(seg, good.slice(0, 5));
    expect(await a2.compact()).toBe(0);
    expect(f.files.has(`devices/macA/${segmentName(1)}`)).toBe(true);
    f.files.set(seg, good);
    await a2.round();
    expect([...f.files.keys()].filter((k) => k.startsWith("devices/macA/") && k.endsWith(".jsonl"))).toEqual([`devices/macA/${snapshotName(3)}`]);
  });

  it("BSD-334: Anhänge unter assets/<hash> – einmal geschrieben, beim Lesen geprüft, halbe Datei gilt als nicht da", async () => {
    const f = folder();
    const blobsA = new MemoryAssetBlobStore(), blobsB = new MemoryAssetBlobStore();
    const bytes = new TextEncoder().encode("a picture, pretend");
    const hash = await sha256Hex(bytes);
    await blobsA.put(hash, bytes);
    const a = new FolderAssets(f, blobsA), b = new FolderAssets(f, blobsB);
    expect(await b.get(hash)).toBeUndefined();
    expect(await a.push()).toBe(1);
    expect(await a.push()).toBe(0); // schon da: nie neu geschrieben
    const full = f.files.get(`assets/${hash}`)!;
    f.files.set(`assets/${hash}`, full.slice(0, 4)); // iCloud lädt noch
    expect(await b.get(hash)).toBeUndefined();
    expect(await blobsB.has(hash)).toBe(false);
    f.files.set(`assets/${hash}`, full);
    expect(await b.get(hash)).toEqual(bytes);
    expect(await blobsB.has(hash)).toBe(true);
    expect(await b.get("../evil")).toBeUndefined();
  });
});
