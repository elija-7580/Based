// Gliederung einer Seite: die Überschriften in Dokumentreihenfolge (für die schwebende Gliederung am rechten Rand
// und den Inhaltsverzeichnis-Block). Rein über Records; Unterseiten und Datenbanken zählen nicht mit, der Inhalt
// von Synced Blocks schon (er steht sichtbar auf der Seite).
import type { Block } from "../model/records.js";
import { plainText } from "../richtext.js";

export interface HeadingSource {
  readonly blocks: ReadonlyMap<string, Block>;
  children(parent: string): readonly string[];
}

export interface OutlineHeading {
  id: string;
  /** 1–4 wie im Record. */
  level: number;
  /** Einrückung ab 0, relativ zur kleinsten vorkommenden Ebene und ohne Sprünge (H1 → H3 rückt nur eine Stufe ein). */
  depth: number;
  title: string;
}

const STOP = new Set(["page", "databasePage", "databaseInline", "linkToPage"]);

export function headingOutline(src: HeadingSource, rootID: string): OutlineHeading[] {
  const raw: { id: string; level: number; title: string }[] = [];
  const seenRoots = new Set<string>([rootID]);
  const walk = (parent: string) => {
    for (const id of src.children(parent)) {
      const b = src.blocks.get(id);
      if (!b || b.trashedAt !== undefined) continue;
      const m = /^heading([1-4])$/.exec(b.type);
      if (m) raw.push({ id, level: Number(m[1]), title: plainText(b.text).trim() || "Untitled" });
      if (STOP.has(b.type)) continue;
      if (b.type === "syncedBlock") {
        const root = b.props?.syncSource ?? b.id;
        if (seenRoots.has(root) || !src.blocks.has(root)) continue;
        seenRoots.add(root);
        walk("b:" + root);
        continue;
      }
      walk("b:" + id);
    }
  };
  walk("b:" + rootID);
  return withDepth(raw);
}

/** Einrückung ohne Sprünge: jede Überschrift höchstens eine Stufe tiefer als die vorige. */
export function withDepth(items: readonly { id: string; level: number; title: string }[]): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  const stack: number[] = []; // Ebenen der offenen Vorfahren
  for (const h of items) {
    while (stack.length > 0 && stack[stack.length - 1]! >= h.level) stack.pop();
    out.push({ ...h, depth: stack.length });
    stack.push(h.level);
  }
  return out;
}

/**
 * Aktuelle Position: die letzte Überschrift, deren Oberkante höchstens `offset` unter dem oberen Rand des
 * Sichtbereichs liegt (`tops` = Abstand der Überschriften zum oberen Rand, in Dokumentreihenfolge). Vor der
 * ersten Überschrift gilt die erste.
 */
export function activeHeadingIndex(tops: readonly number[], offset = 0): number {
  if (tops.length === 0) return -1;
  let active = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i]! <= offset) active = i;
    else break;
  }
  return active;
}
