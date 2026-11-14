// BSD-231 Teil 2b: OPFS-Ablage für lokale Modelle – mit einem nachgebauten OPFS-Ordner (Verzeichnisse, Dateien,
// createWritable bzw. createSyncAccessHandle) und dem echten LocalModelManager: laden, prüfen, lesen, entfernen.
import { localModels } from "@based/brain";
import { describe, expect, it } from "vitest";
import { opfsModelStore, splitModelPath } from "./opfsModels.js";

class FakeFile {
  data = new Uint8Array();
  constructor(readonly sync: boolean) {}
  async getFile() { return new Blob([this.data as Uint8Array<ArrayBuffer>]); }
  async createWritable() {
    const parts: Uint8Array[] = [];
    return { write: async (b: Uint8Array) => { parts.push(b.slice()); }, close: async () => { this.data = new Uint8Array(await new Blob(parts as Uint8Array<ArrayBuffer>[]).arrayBuffer()); } };
  }
}
class FakeSyncFile extends FakeFile {
  async createSyncAccessHandle() {
    return {
      truncate: (n: number) => { this.data = this.data.slice(0, n); },
      write: (b: Uint8Array, o?: { at: number }) => { const at = o?.at ?? 0; const next = new Uint8Array(Math.max(this.data.length, at + b.length)); next.set(this.data); next.set(b, at); this.data = next; return b.length; },
      flush: () => {}, close: () => {},
    };
  }
}
class FakeDir {
  readonly dirs = new Map<string, FakeDir>();
  readonly files = new Map<string, FakeFile>();
  constructor(readonly sync = false) {}
  async getDirectoryHandle(name: string, o?: { create?: boolean }) {
    let d = this.dirs.get(name);
    if (!d) { if (!o?.create) throw new DOMException("missing", "NotFoundError"); d = new FakeDir(this.sync); this.dirs.set(name, d); }
    return d;
  }
  async getFileHandle(name: string, o?: { create?: boolean }) {
    let f = this.files.get(name);
    if (!f) { if (!o?.create) throw new DOMException("missing", "NotFoundError"); f = this.sync ? new FakeSyncFile(true) : new FakeFile(false); this.files.set(name, f); }
    return f;
  }
  async removeEntry(name: string) { if (!this.files.delete(name)) throw new DOMException("missing", "NotFoundError"); }
}

const bytes = new TextEncoder().encode("tiny model weights");

async function spec(): Promise<localModels.LocalModelSpec> {
  return { id: "tiny", version: "1", purpose: "embeddings", name: "Tiny", license: "MIT", files: [{ path: "onnx/model.bin", url: "https://example.test/model.bin", size: bytes.length, sha256: await localModels.sha256Hex(bytes) }] };
}

describe("OPFS-Ablage für lokale Modelle", () => {
  it("Pfade: Ordner und Name, „..“ und leere Teile abgelehnt", () => {
    expect(splitModelPath("tiny/1/onnx/model.bin")).toEqual({ dirs: ["tiny", "1", "onnx"], name: "model.bin" });
    expect(splitModelPath("tiny/../x")).toBeUndefined();
    expect(splitModelPath("tiny//x")).toBeUndefined();
  });

  for (const sync of [false, true]) {
    it(`laden, prüfen, lesen, entfernen (${sync ? "createSyncAccessHandle" : "createWritable"})`, async () => {
      const root = new FakeDir(sync);
      const store = opfsModelStore(root as unknown as FileSystemDirectoryHandle);
      let requests = 0;
      const fetch = (async () => { requests++; return new Response(bytes); }) as typeof globalThis.fetch;
      const s = await spec();
      const off = new localModels.LocalModelManager({ store, fetch, consent: () => new Set() });
      await expect(off.download(s)).rejects.toBeInstanceOf(localModels.ConsentRequired);
      expect(requests).toBe(0);
      const m = new localModels.LocalModelManager({ store, fetch, consent: () => new Set(["embeddings"]) });
      expect(await m.installed(s)).toBe(false);
      await m.download(s);
      expect(requests).toBe(1);
      expect(await m.installed(s)).toBe(true);
      expect(await m.file(s, "onnx/model.bin")).toEqual(bytes);
      // ein abgeschnittener File (Abbruch beim Schreiben) gilt als nicht installiert und wird neu geladen
      await store.put("tiny/1/onnx/model.bin", bytes.slice(0, 4));
      expect(await m.installed(s)).toBe(false);
      await m.download(s);
      expect(requests).toBe(2);
      await m.remove(s);
      expect(await m.installed(s)).toBe(false);
      expect(await store.get("tiny/1/onnx/model.bin")).toBeUndefined();
      await store.delete("nope/1/x"); // fehlende Ordner: still
    });
  }
});
