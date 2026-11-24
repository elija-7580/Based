// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// BSD-665: Import-Nutzlast als Bytes verpacken. Ein großer Import (10 000 Notion-Seiten) ging als Objektbaum vom
// Import-Worker über den Hauptthread zum Store-Worker; beide Klone (Empfang und Weitergabe) liefen im Hauptthread und
// froren das Fenster am Ende ~1 s ein. Verpackt kodiert der Import-Worker die Records einmal (JSON → UTF-8) und
// überträgt den Puffer (Transferable); der Hauptthread reicht nur Bytes weiter, ausgepackt wird im Store-Worker.
//
// Was JSON nicht kennt, bleibt erhalten: Bytes (Uint8Array, als eigene übertragene Puffer), NaN/±Infinity, Map, Set,
// Date und `undefined` in Arrays. `undefined` in Objekten entfällt wie in jedem gespeicherten Record.
// Nicht verpackt bleiben `notes` (der Hauptthread hängt Hinweise an), `assets` und `files` (schon übertragbar).
import type { ImportPayload } from "./prepare-files.js";

/** Kennung verpackter Sonderwerte; kommt in Record-Schlüsseln nicht vor (NUL). */
const TAG = "\u0000based-codec";

export interface PackedImportRecords {
  /** UTF-8-JSON von `{ notion, archives }`. */
  json: Uint8Array;
  /** Bytes, auf die `json` per Index zeigt. */
  bins: Uint8Array[];
}

export interface PackedImportPayload {
  packed: PackedImportRecords;
  notes: string[];
  assets: number;
  files?: ImportPayload["files"];
}

export const isPackedImportPayload = (p: ImportPayload | PackedImportPayload): p is PackedImportPayload =>
  (p as Partial<PackedImportPayload>).packed !== undefined;

type Tagged =
  | { [TAG]: "b"; i: number }
  | { [TAG]: "n"; v: "NaN" | "Infinity" | "-Infinity" }
  | { [TAG]: "u" }
  | { [TAG]: "m"; v: [unknown, unknown][] }
  | { [TAG]: "s"; v: unknown[] }
  | { [TAG]: "d"; v: number };

/** Einen eigenen Puffer liefern (ein Ausschnitt würde beim Übertragen den ganzen Puffer abkoppeln). */
function own(a: Uint8Array): Uint8Array {
  return a.byteOffset === 0 && a.byteLength === a.buffer.byteLength && a.buffer instanceof ArrayBuffer ? a : a.slice();
}

/** Beliebigen Wert verpacken (Grundlage von `packImportPayload`; auch für Tests). */
export function packValue(value: unknown): PackedImportRecords {
  const bins: Uint8Array[] = [];
  const text = JSON.stringify(value, function (this: unknown, key: string, v: unknown): unknown {
    // `v` ist schon durch `toJSON` gelaufen (Date → Text); das Original steht im Halter.
    const raw = (this as Record<string, unknown>)[key];
    if (raw instanceof Date) return { [TAG]: "d", v: raw.getTime() } satisfies Tagged;
    if (typeof v === "number") {
      if (Number.isFinite(v)) return v;
      return { [TAG]: "n", v: Number.isNaN(v) ? "NaN" : v > 0 ? "Infinity" : "-Infinity" } satisfies Tagged;
    }
    if (v === undefined) return Array.isArray(this) ? ({ [TAG]: "u" } satisfies Tagged) : undefined;
    if (v instanceof Uint8Array) {
      bins.push(own(v));
      return { [TAG]: "b", i: bins.length - 1 } satisfies Tagged;
    }
    if (v instanceof Map) return { [TAG]: "m", v: [...v] } satisfies Tagged;
    if (v instanceof Set) return { [TAG]: "s", v: [...v] } satisfies Tagged;
    return v;
  });
  return { json: new TextEncoder().encode(text ?? "null"), bins };
}

/** Gegenstück zu `packValue`. */
export function unpackValue(p: PackedImportRecords): unknown {
  const text = new TextDecoder().decode(p.json);
  return JSON.parse(text, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || !(TAG in v)) return v;
    const t = v as Tagged;
    switch (t[TAG]) {
      case "b": {
        const b = p.bins[t.i];
        if (!b) throw new Error("Import data is damaged (missing bytes).");
        return b;
      }
      case "n": return Number(t.v);
      case "u": return undefined;
      case "m": return new Map(t.v);
      case "s": return new Set(t.v);
      case "d": return new Date(t.v);
    }
    return v;
  });
}

/**
 * Nutzlast für die Reise Import-Worker → Hauptthread → Store-Worker verpacken. `transfer`: die Puffer, die der
 * Worker mit `postMessage` überträgt (Records, Bytes darin und die Dateien) – danach sind sie im Worker leer.
 */
export function packImportPayload(p: ImportPayload): { payload: PackedImportPayload; transfer: ArrayBuffer[] } {
  const packed = packValue({ notion: p.notion, archives: p.archives });
  const files = p.files?.map((f) => ({ ...f, data: own(f.data) }));
  const payload: PackedImportPayload = { packed, notes: p.notes, assets: p.assets, ...(files ? { files } : {}) };
  const transfer = new Set<ArrayBuffer>([packed.json, ...packed.bins, ...(files ?? []).map((f) => f.data)].map((a) => a.buffer as ArrayBuffer));
  return { payload, transfer: [...transfer] };
}

/** Im Store-Worker auspacken; eine unverpackte Nutzlast (Tests, ältere Wege) kommt unverändert zurück. */
export function unpackImportPayload(p: ImportPayload | PackedImportPayload): ImportPayload {
  if (!isPackedImportPayload(p)) return p;
  const rec = unpackValue(p.packed) as Pick<ImportPayload, "notion" | "archives">;
  return { notion: rec.notion ?? undefined, archives: rec.archives ?? [], notes: p.notes, assets: p.assets, ...(p.files ? { files: p.files } : {}) };
}
