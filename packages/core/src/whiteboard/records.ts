// BSD-264 (Whiteboard 2): Board-Objekte als Records. Die Records sind die Quelle (wie beim Text: der Y-Zustand der
// offenen Sitzung ist nur das lebende Modell). Jedes Objekt ist ein eigener `block`-Record:
//
//   { id, type: "boardObject", parent: "b:<Seite>", sk: <z>, text?: <Text bzw. Label>,
//     props: { wb: { kind, x, y, w, h, rot, style?, ref?, ink? (Base64), from?, to?, shape?, …unbekannte Felder } } }
//
// Damit läuft ein Board durch alles, was Blöcke schon können: Speichern (OPFS), Sync v2 (LWW je Objekt – zwei Geräte,
// die verschiedene Objekte ändern, verlieren nichts), Backups, Based-Archiv, Papierkorb, Duplizieren, Verlauf.
// - `sk` ist die einzige Reihenfolge (z als fraktionaler Index, wie bei Geschwister-Blöcken).
// - `text` liegt auf dem Block, damit die Suche Zettel-Texte findet und die Seite als Treffer zeigt.
// - `type` ist ein offenes Enum (ADR 0002): Versionen ohne Board behalten die Records unverändert und reichen sie
//   weiter; sie zeigen die Seite nur nicht als Board.
// Eine Board-Seite ist eine normale Seite (`type: "page"`) mit `props.board = { v: 1 }`.
import type { Block } from "../model/records.js";
import type { Tx, WorkspaceStore } from "../store/store.js";
import { insertPage, type CreatePageOptions } from "../store/pages.js";
import { canonicalStringify } from "../json.js";
import { parseWBObject, wbFields, type WBObject } from "./model.js";

export const BOARD_OBJECT_TYPE = "boardObject";
/** Format der Board-Records (für spätere Migrationen). */
export const BOARD_FORMAT = 1;

/** Ist der Block eine Board-Seite? */
export function isBoardPage(b: Pick<Block, "type" | "props"> | undefined): boolean {
  const board = (b?.props as Record<string, unknown> | undefined)?.board;
  return b?.type === "page" && typeof board === "object" && board !== null;
}

export function isBoardObjectBlock(b: Pick<Block, "type"> | undefined): boolean {
  return b?.type === BOARD_OBJECT_TYPE;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(s: string): Uint8Array | undefined {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

/** Board-Objekt aus seinem Record; `undefined`, wenn der Block kein (lesbares) Board-Objekt ist. */
export function boardObjectFromBlock(b: Block): WBObject | undefined {
  if (b.type !== BOARD_OBJECT_TYPE) return undefined;
  const wb = (b.props as Record<string, unknown> | undefined)?.wb;
  if (!wb || typeof wb !== "object") return undefined;
  const raw: Record<string, unknown> = { ...(wb as Record<string, unknown>), id: b.id, z: b.sk };
  const ink = typeof raw.ink === "string" ? fromBase64(raw.ink) : undefined;
  if (ink) raw.ink = ink;
  else delete raw.ink;
  const text = typeof b.text === "string" ? b.text : Array.isArray(b.text) ? b.text.map((r) => r.t ?? "").join("") : undefined;
  if (text !== undefined && text !== "") raw[raw.kind === "connector" ? "label" : "text"] = text;
  return parseWBObject(raw);
}

/** Die Felder eines Objekts, wie sie in `props.wb` stehen (ohne id, z, Text). */
export function boardObjectProps(obj: WBObject): Record<string, unknown> {
  const { id: _id, z: _z, text: _text, label: _label, ink, ...rest } = wbFields(obj) as Record<string, unknown> & { ink?: unknown };
  return ink instanceof Uint8Array ? { ...rest, ink: toBase64(ink) } : rest;
}

const fingerprint = (o: WBObject) => canonicalStringify({ z: o.z, t: (o.kind === "connector" ? o.label : o.text) ?? "", p: boardObjectProps(o) });

/** Gleicher Inhalt (alle Felder inkl. Tinte, Reihenfolge und unbekannter Felder)? */
export function sameBoardObject(a: WBObject | undefined, b: WBObject | undefined): boolean {
  if (!a || !b) return a === b;
  return a.id === b.id && fingerprint(a) === fingerprint(b);
}

/**
 * Record für ein Objekt. `existing`: der bisherige Record – Anlegedaten und unbekannte Felder daneben bleiben
 * erhalten. Zeiten und Stempel setzt der Store beim Speichern.
 */
export function boardObjectToBlock(obj: WBObject, pageID: string, now: number, existing?: Block): Block {
  const text = obj.kind === "connector" ? obj.label : obj.text;
  const b: Block = {
    ...(existing ? structuredClone(existing) : { createdAt: now }),
    id: obj.id,
    type: BOARD_OBJECT_TYPE,
    parent: "b:" + pageID,
    sk: obj.z,
    updatedAt: now,
    props: { ...((existing?.props as Record<string, unknown> | undefined) ?? {}), wb: boardObjectProps(obj) } as Block["props"],
  } as Block;
  if (text !== undefined && text !== "") b.text = text;
  else delete b.text;
  return b;
}

/** Alle Objekte einer Board-Seite, von hinten nach vorn (Reihenfolge des Stores: sk, dann id). */
export function boardObjectsOf(store: WorkspaceStore, pageID: string): WBObject[] {
  const out: WBObject[] = [];
  for (const id of store.children("b:" + pageID)) {
    const b = store.blocks.get(id);
    const o = b && !b.trashedAt ? boardObjectFromBlock(b) : undefined;
    if (o) out.push(o);
  }
  return out;
}

/** Board-Seite in einer laufenden Transaktion anlegen. */
export function insertBoardPage(store: WorkspaceStore, tx: Tx, opts: CreatePageOptions = {}): string {
  const id = insertPage(store, tx, opts);
  tx.update(id, (b) => {
    b.props = { ...(b.props ?? {}), board: { v: BOARD_FORMAT } } as Block["props"];
  });
  return id;
}

/** Neue Board-Seite (oben in Private bzw. unter `opts.parent`). */
export function createBoardPage(store: WorkspaceStore, opts: CreatePageOptions = {}): string {
  return store.transact("New board", (tx) => insertBoardPage(store, tx, opts));
}
