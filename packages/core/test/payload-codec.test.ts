// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// BSD-665: verpackte Import-Nutzlast (Records als Bytes) kommt unverändert an – mit Dateien, Datenbanken,
// Platzhalter-Dateien im Builder und Sonderwerten, die JSON allein nicht kennt.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  commitImportPayload, isPackedImportPayload, MemoryAssetSink, packImportPayload, packValue, prepareFiles, unpackImportPayload, unpackValue,
  MemoryPersistence, WorkspaceStore, type ImportFile, type ImportPayload,
} from "../src/index.js";

type Fixture = { cases: { input: { files?: { path: string; text?: string; base64?: string }[] } }[] };
function notionExport(): ImportFile[] {
  const fx = JSON.parse(readFileSync(new URL("../../../fixtures/import/notion-html.utc.json", import.meta.url), "utf8")) as Fixture;
  return fx.cases[0]!.input.files!.map((f) => ({ path: "Export/" + f.path, data: f.base64 !== undefined ? Uint8Array.from(Buffer.from(f.base64, "base64")) : new TextEncoder().encode(f.text ?? "") }));
}

/** Wie `postMessage` mit Transfer-Liste: klonen und die übertragenen Puffer beim Absender abkoppeln. */
const send = <T>(v: T, transfer: ArrayBuffer[]): T => structuredClone(v, { transfer });

describe("Import-Nutzlast verpacken (BSD-665)", () => {
  it("Notion-Export mit Dateien und Datenbanken übersteht Verpacken, Übertragen und Auspacken unverändert", () => {
    const payload = prepareFiles(notionExport(), { assets: new MemoryAssetSink() });
    expect(payload.files?.length).toBeGreaterThan(0);
    expect(payload.notion?.builder?.databases.length).toBeGreaterThan(0);
    const expected = structuredClone(payload);

    const { payload: packed, transfer } = packImportPayload(payload);
    expect(isPackedImportPayload(packed)).toBe(true);
    expect("notion" in packed).toBe(false);
    // Records und Dateien gehen als Puffer, nicht als Objektbaum
    expect(transfer).toContain(packed.packed.json.buffer);
    for (const f of packed.files ?? []) expect(transfer).toContain(f.data.buffer);

    const arrived = send(packed, transfer);
    expect(packed.packed.json.byteLength).toBe(0); // beim Absender abgekoppelt
    expect(unpackImportPayload(arrived)).toEqual(expected);
  });

  it("schreibt verpackt dieselben Records wie unverpackt", () => {
    const write = (p: ImportPayload | ReturnType<typeof packImportPayload>["payload"]) => {
      const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t", now: () => 100 });
      const s = commitImportPayload(store, unpackImportPayload(p));
      return { s, blocks: [...store.blocks.values()].map((b) => ({ ...b, stamp: undefined })).sort((a, b) => a.id.localeCompare(b.id)), dbs: [...store.databases.keys()].sort() };
    };
    const plain = write(prepareFiles(notionExport()));
    const p = packImportPayload(prepareFiles(notionExport()));
    const packed = write(send(p.payload, p.transfer));
    expect(packed.s).toEqual(plain.s);
    expect(packed.dbs).toEqual(plain.dbs);
    expect(packed.blocks.length).toBe(plain.blocks.length);
    expect(packed.blocks.map((b) => [b.id, b.type, b.parent, b.text])).toEqual(plain.blocks.map((b) => [b.id, b.type, b.parent, b.text]));
  });

  it("Sonderwerte: Bytes, NaN/Infinity, Map, Set, Date, undefined in Arrays; Ausschnitte werden eigene Puffer", () => {
    const big = new Uint8Array([9, 1, 2, 3, 9]);
    const value = {
      bytes: big.subarray(1, 4), empty: new Uint8Array(0), n: [NaN, Infinity, -Infinity, 0, 1.5],
      m: new Map([["a", 1]]), s: new Set(["x"]), d: new Date(1_700_000_000_000), arr: [1, undefined, 3], dropped: undefined, text: "ü \u0000 😀",
    };
    const packed = packValue(value);
    expect(packed.bins[0]!.byteLength).toBe(3);
    expect(packed.bins[0]!.buffer.byteLength).toBe(3);
    const back = unpackValue(packed) as typeof value;
    expect([...back.bytes]).toEqual([1, 2, 3]);
    expect(back.empty).toBeInstanceOf(Uint8Array);
    expect(back.n).toEqual([NaN, Infinity, -Infinity, 0, 1.5]);
    expect(back.m).toEqual(new Map([["a", 1]]));
    expect(back.s).toEqual(new Set(["x"]));
    expect(back.d.getTime()).toBe(1_700_000_000_000);
    expect(back.arr.length).toBe(3);
    expect(back.arr[0]).toBe(1);
    expect(back.arr[1]).toBeUndefined();
    expect(back.arr[2]).toBe(3);
    expect("dropped" in back).toBe(false);
    expect(back.text).toBe("ü \u0000 😀");
  });

  it("unverpackte Nutzlast bleibt, wie sie ist; Hinweise des Hauptthreads gehen mit", () => {
    const payload = prepareFiles(notionExport());
    expect(unpackImportPayload(payload)).toBe(payload);
    const { payload: packed } = packImportPayload(payload);
    packed.notes.push("1 attached file couldn't be saved");
    expect(unpackImportPayload(packed).notes).toContain("1 attached file couldn't be saved");
  });
});
