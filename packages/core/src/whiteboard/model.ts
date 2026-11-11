// BSD-263 (Whiteboard 1, Teil von BSD-93): Datenmodell eines Boards. Ein Board ist eine Seite mit Board-Inhalt;
// jedes Objekt ist ein eigener Eintrag (in Yjs eine Y.Map, packages/editor/src/whiteboard), Verbindungen sind eigene
// Objekte. Reihenfolge (z) als fraktionaler Index wie Sortierschlüssel (sortkeys.ts) – Einfügen ohne Umnummerieren,
// auch wenn zwei Geräte gleichzeitig etwas nach vorn holen. Unbekannte Felder (neuere Version) bleiben erhalten.
import { keyBetween } from "../sortkeys.js";

export const WB_KINDS = ["note", "shape", "text", "image", "ink", "frame", "page", "connector"] as const;
export type WBKind = (typeof WB_KINDS)[number];
export type ConnectorSide = "top" | "right" | "bottom" | "left" | "auto";
export type ConnectorShape = "curved" | "straight" | "elbow";
export type WBStyleValue = string | number | boolean;

interface WBBase {
  id: string;
  /** Fraktionaler Index; größer = weiter vorn. */
  z: string;
  style?: Record<string, WBStyleValue>;
  /** Felder einer neueren Version, unverändert behalten. */
  extra?: Record<string, unknown>;
}

export interface WBShape extends WBBase {
  kind: Exclude<WBKind, "connector">;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Drehung in Grad. */
  rot: number;
  text?: string;
  /** Verweis: Seite (kind „page“) oder Datei-Hash (kind „image“). */
  ref?: string;
  /** Tinte (kind „ink“): `encodeInk`, Punkte relativ zu x/y. */
  ink?: Uint8Array;
}

export interface ConnectorEnd { id: string; side: ConnectorSide }

export interface WBConnector extends WBBase {
  kind: "connector";
  from: ConnectorEnd;
  to: ConnectorEnd;
  shape: ConnectorShape;
  label?: string;
}

export type WBObject = WBShape | WBConnector;

const KNOWN = new Set(["id", "kind", "z", "style", "x", "y", "w", "h", "rot", "text", "ref", "ink", "from", "to", "shape", "label"]);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const SIDES = new Set<ConnectorSide>(["top", "right", "bottom", "left", "auto"]);
const end = (v: unknown): ConnectorEnd | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id === "") return undefined;
  return { id: o.id, side: SIDES.has(o.side as ConnectorSide) ? (o.side as ConnectorSide) : "auto" };
};

/**
 * Ein Objekt aus Rohdaten (Yjs, Sync, Import) lesen. `undefined` bei Unbrauchbarem (keine ID, unbekannte Art,
 * Verbindung ohne Enden); fehlende Zahlen bekommen Standardwerte, unbekannte Felder landen in `extra`.
 */
export function parseWBObject(raw: unknown): WBObject | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id === "" || !(WB_KINDS as readonly string[]).includes(o.kind as string)) return undefined;
  const base: WBBase = { id: o.id, z: typeof o.z === "string" && o.z !== "" ? o.z : "a0" };
  if (o.style && typeof o.style === "object") {
    const style: Record<string, WBStyleValue> = {};
    for (const [k, v] of Object.entries(o.style)) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") style[k] = v;
    base.style = style;
  }
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (!KNOWN.has(k)) extra[k] = v;
  if (Object.keys(extra).length > 0) base.extra = extra;
  if (o.kind === "connector") {
    const from = end(o.from), to = end(o.to);
    if (!from || !to) return undefined;
    const shape = o.shape === "straight" || o.shape === "elbow" ? o.shape : "curved";
    return { ...base, kind: "connector", from, to, shape, ...(typeof o.label === "string" ? { label: o.label } : {}) };
  }
  const s: WBShape = { ...base, kind: o.kind as WBShape["kind"], x: num(o.x, 0), y: num(o.y, 0), w: Math.max(0, num(o.w, 0)), h: Math.max(0, num(o.h, 0)), rot: num(o.rot, 0) % 360 };
  if (typeof o.text === "string") s.text = o.text;
  if (typeof o.ref === "string") s.ref = o.ref;
  if (o.ink instanceof Uint8Array) s.ink = o.ink;
  return s;
}

/** Objekt als flache Felder (für Yjs/JSON); `extra` kommt zurück an die Oberfläche. */
export function wbFields(obj: WBObject): Record<string, unknown> {
  const { extra, ...rest } = obj;
  return { ...(extra ?? {}), ...rest };
}

/** Reihenfolge von hinten nach vorn (z, dann id – deterministisch auf allen Geräten). */
export function sortByZ<T extends { id: string; z: string }>(objs: readonly T[]): T[] {
  return [...objs].sort((a, b) => (a.z < b.z ? -1 : a.z > b.z ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** z für „ganz nach vorn“ bzw. „ganz nach hinten“. */
export function frontZ(objs: readonly { z: string }[]): string {
  const max = objs.reduce<string | undefined>((m, o) => (m === undefined || o.z > m ? o.z : m), undefined);
  return keyBetween(max, undefined);
}
export function backZ(objs: readonly { z: string }[]): string {
  const min = objs.reduce<string | undefined>((m, o) => (m === undefined || o.z < m ? o.z : m), undefined);
  return keyBetween(undefined, min);
}

/** Achsenparalleles Rechteck um ein gedrehtes Objekt (Auswahl, Sichtbarkeit). */
export function bounds(s: Pick<WBShape, "x" | "y" | "w" | "h" | "rot">): { x: number; y: number; w: number; h: number } {
  const r = (s.rot * Math.PI) / 180, c = Math.abs(Math.cos(r)), si = Math.abs(Math.sin(r));
  const w = s.w * c + s.h * si, h = s.w * si + s.h * c;
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Verbindungen, die nach dem Löschen von `ids` ins Leere zeigen (werden mit gelöscht). */
export function danglingConnectors(objs: readonly WBObject[], ids: ReadonlySet<string>): string[] {
  return objs.filter((o): o is WBConnector => o.kind === "connector" && (ids.has(o.from.id) || ids.has(o.to.id))).map((o) => o.id);
}
