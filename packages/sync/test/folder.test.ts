// BSD-296 (Spike): Sync über einen geteilten Ordner (iCloud Drive). Zwei simulierte Geräte, gleichzeitige Änderungen
// an verschiedenen Blöcken, halbe Datei (iCloud lädt noch), Löschung, Konflikt-Kopie, Schalter aus.
import { describe, expect, it } from "vitest";
import { createPage, emptyTrash, MemoryPersistence, renamePage, trashPages, WorkspaceStore } from "@based/core";
import { FolderSync, parseSegment, segmentName, type FolderTarget } from "../src/index.js";

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
    const aSegments = [...f.files.keys()].filter((k) => k.startsWith("devices/macA/"));
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
});
