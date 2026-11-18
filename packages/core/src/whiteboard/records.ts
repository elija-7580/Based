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
import { keyBetween } from "../sortkeys.js";

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
export function boardObjectToBlock(obj: WBObject, pageID: string, now: number, existing?: Block, byID?: ReadonlyMap<string, WBObject>): Block {
  const text = obj.kind === "connector" ? obj.label : obj.text;
  // BSD-267: echte Links. Eine Seitenkarte verlinkt vom Board auf ihre Seite; eine Verbindung zwischen zwei
  // Seitenkarten ist ein Link von der einen Seite zur anderen (Backlinks und Graph lesen linkTarget/linkSource).
  const link: { linkTarget?: string; linkSource?: string } = {};
  if (obj.kind === "page" && obj.ref) link.linkTarget = obj.ref;
  else if (obj.kind === "connector") {
    const a = byID?.get(obj.from.id), b = byID?.get(obj.to.id);
    if (a?.kind === "page" && b?.kind === "page" && a.ref && b.ref && a.ref !== b.ref) { link.linkSource = a.ref; link.linkTarget = b.ref; }
  }
  const { linkTarget: _lt, linkSource: _ls, ...keptProps } = ((existing?.props as Record<string, unknown> | undefined) ?? {});
  const b: Block = {
    ...(existing ? structuredClone(existing) : { createdAt: now }),
    id: obj.id,
    type: BOARD_OBJECT_TYPE,
    parent: "b:" + pageID,
    sk: obj.z,
    updatedAt: now,
    props: { ...keptProps, ...link, wb: boardObjectProps(obj) } as Block["props"],
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

/** Untergrund der Fläche (an der Seite, `props.board.bg`). */
export type BoardBackground = "dots" | "lines" | "grid" | "plain";
export const BOARD_BACKGROUNDS: readonly { id: BoardBackground; label: string }[] = [
  { id: "dots", label: "Dots" }, { id: "lines", label: "Lines" }, { id: "grid", label: "Grid" }, { id: "plain", label: "Plain" },
];
export function boardBackground(store: WorkspaceStore, pageID: string): BoardBackground {
  const bg = ((store.blocks.get(pageID)?.props as { board?: { bg?: unknown } } | undefined)?.board)?.bg;
  return bg === "lines" || bg === "grid" || bg === "plain" ? bg : "dots";
}
export function setBoardBackground(store: WorkspaceStore, pageID: string, bg: BoardBackground) {
  store.transact("Board background", (tx) => tx.update(pageID, (b) => {
    const props = (b.props ?? {}) as Record<string, unknown>;
    b.props = { ...props, board: { ...((props.board as Record<string, unknown> | undefined) ?? {}), bg } } as Block["props"];
  }));
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

// Elija 18.11.: eine Unterseite, die in der Seitenleiste unter einem Board angelegt wird, liegt sofort als Karte auf
// dem Board. Die Karte hat eine feste ID je Seite: zwei Geräte legen dieselbe Karte an (kein Doppel nach dem Sync),
// und eine Karte, die jemand vom Board gelöscht hat, bleibt gelöscht (der Record liegt dann im Papierkorb).

/** Feste ID der Karte, die eine Unterseite auf ihrem Board zeigt. */
export const boardPageCardID = (pageID: string) => "wbp-" + pageID;
/** Größe einer Karte für eine neue Unterseite (wie „ganze Seite“ in der Werkzeugleiste). */
export const BOARD_PAGE_CARD = { w: 520, h: 620 } as const;
const CARD_GAP = 40;

/** Unterseiten des Boards ohne Karte (und ohne gelöschte Karte). */
export function boardPagesWithoutCard(store: WorkspaceStore, boardID: string): string[] {
  const objs = boardObjectsOf(store, boardID);
  const shown = new Set(objs.flatMap((o) => (o.kind === "page" && o.ref ? [o.ref] : [])));
  return store.children("b:" + boardID).filter((id) => {
    const b = store.blocks.get(id);
    return !!b && !b.trashedAt && (b.type === "page" || b.type === "databasePage") && !shown.has(id) && !store.blocks.has(boardPageCardID(id));
  });
}

/**
 * Karten für Unterseiten in einer laufenden Transaktion ablegen: rechts neben allem, was schon auf dem Board liegt,
 * oben bündig (leeres Board: um den Ursprung). Gibt die Zahl der neuen Karten zurück.
 */
export function insertBoardPageCards(store: WorkspaceStore, tx: Tx, boardID: string, pageIDs: readonly string[]): number {
  if (!isBoardPage(store.blocks.get(boardID)) || pageIDs.length === 0) return 0;
  const objs = boardObjectsOf(store, boardID);
  let right = -Infinity, top = Infinity;
  let z: string | undefined;
  for (const o of objs) {
    if (z === undefined || o.z > z) z = o.z;
    if (o.kind === "connector") continue;
    right = Math.max(right, o.x + o.w);
    top = Math.min(top, o.y);
  }
  let x = Number.isFinite(right) ? Math.round(right + CARD_GAP) : -Math.round(BOARD_PAGE_CARD.w / 2);
  const y = Number.isFinite(top) ? Math.round(top) : -Math.round(BOARD_PAGE_CARD.h / 2);
  const now = store.now();
  let n = 0;
  for (const pageID of pageIDs) {
    const id = boardPageCardID(pageID);
    if (store.blocks.has(id)) continue;
    z = keyBetween(z, undefined);
    const title = store.blocks.get(pageID)?.text;
    const obj: WBObject = { id, kind: "page", z, x, y, ...BOARD_PAGE_CARD, rot: 0, ref: pageID, text: (typeof title === "string" && title) || "Untitled", style: { full: true } };
    tx.put({ kind: "block", data: boardObjectToBlock(obj, boardID, now) });
    x += BOARD_PAGE_CARD.w + CARD_GAP;
    n++;
  }
  return n;
}

// Elija 18.11.: ein Board mitten in einer Seite lässt sich auf einen Ausschnitt sperren. Gesperrt bewegt es sich nicht
// mit; ein Doppelklick betritt es, beim Verlassen springt es auf den gesperrten Ausschnitt zurück. Der Ausschnitt liegt
// an der Board-Seite (`props.board.embedView`) – die Board-Seite ist der Block, der in ihrer Elternseite steht.
export interface BoardEmbedView { x: number; y: number; zoom: number }

export function boardEmbedView(b: Pick<Block, "props"> | undefined): BoardEmbedView | undefined {
  const v = ((b?.props as { board?: { embedView?: unknown } } | undefined)?.board)?.embedView as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") return undefined;
  const { x, y, zoom } = v;
  return typeof x === "number" && typeof y === "number" && typeof zoom === "number" && Number.isFinite(x) && Number.isFinite(y) && zoom > 0 ? { x, y, zoom } : undefined;
}

export function setBoardEmbedView(store: WorkspaceStore, pageID: string, view: BoardEmbedView | undefined) {
  if (!isBoardPage(store.blocks.get(pageID))) return;
  store.transact(view ? "Lock board view" : "Unlock board view", (tx) => tx.update(pageID, (b) => {
    const props = (b.props ?? {}) as Record<string, unknown>;
    const { embedView: _old, ...board } = (props.board as Record<string, unknown> | undefined) ?? {};
    b.props = { ...props, board: view ? { ...board, embedView: { x: view.x, y: view.y, zoom: view.zoom } } : board } as Block["props"];
  }));
}
