// BSD-90: unverlinkte Erwähnungen (wie Obsidian/Swift UnlinkedMentions): Stellen, an denen der Titel einer Seite als
// reiner Text vorkommt (ganze Wörter, Groß/klein egal, Titel ab 3 Zeichen), außerhalb der Seite selbst und nicht in
// schon verlinkten Läufen; `linkUnlinkedMention` macht aus der Stelle eine Seiten-Erwähnung (ein Undo-Schritt).
import type { Block, RichText } from "../model/records.js";
import { isTrashed, titleOf } from "../query/engine.js";
import { containingPage } from "./links.js";
import type { WorkspaceStore } from "./store.js";

export interface UnlinkedMention {
  blockID: string;
  /** Seite, in der die Stelle steht. */
  pageID: string;
  /** Ausschnitt um die Fundstelle. */
  snippet: string;
  /** Lage im reinen Text des Blocks. */
  start: number;
  length: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
type Run = { t?: string; mention?: unknown; [k: string]: unknown };
const runsOf = (t: RichText | undefined): Run[] => (t === undefined ? [] : typeof t === "string" ? [{ t }] : (t as Run[]));
const PAGE_TYPES = new Set(["page", "databasePage", "databaseInline", "meeting", "transcript"]);

export function unlinkedMentions(store: WorkspaceStore, pageID: string, limit = 50): UnlinkedMention[] {
  const title = titleOf(store, pageID).trim();
  if (title.length < 3) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escape(title)}(?![\\p{L}\\p{N}_])`, "giu");
  const out: UnlinkedMention[] = [];
  for (const b of store.blocks.values()) {
    if (out.length >= limit) break;
    if (!b.text || PAGE_TYPES.has(b.type) || b.parent.startsWith("d:")) continue;
    let offset = 0;
    const full = runsOf(b.text).map((r) => r.t ?? "").join("");
    if (!full.toLowerCase().includes(title.toLowerCase())) continue;
    const page = containingPage(store, b.id);
    if (!page || page === pageID || isTrashed(store, b.id)) continue;
    for (const r of runsOf(b.text)) {
      const t = r.t ?? "";
      if (!r.mention) {
        for (const m of t.matchAll(re)) {
          const start = offset + m.index!;
          out.push({ blockID: b.id, pageID: page, start, length: m[0].length, snippet: snippet(full, start, m[0].length) });
        }
      }
      offset += t.length;
    }
  }
  return out.slice(0, limit);
}

function snippet(text: string, start: number, length: number, around = 40): string {
  const a = Math.max(0, start - around), z = Math.min(text.length, start + length + around);
  return (a > 0 ? "…" : "") + text.slice(a, z).replace(/\s+/g, " ") + (z < text.length ? "…" : "");
}

/** Stelle `start`/`length` im Block zu einer Erwähnung von `pageID` machen. Falsch, wenn sie nicht (mehr) passt. */
export function linkUnlinkedMention(store: WorkspaceStore, blockID: string, start: number, length: number, pageID: string): boolean {
  const b = store.blocks.get(blockID);
  if (!b || !store.blocks.has(pageID)) return false;
  const runs = runsOf(b.text);
  const out: Run[] = [];
  let offset = 0, done = false;
  for (const r of runs) {
    const t = r.t ?? "";
    const end = offset + t.length;
    if (!done && !r.mention && start >= offset && start + length <= end) {
      const a = start - offset;
      const { t: _t, ...rest } = r;
      if (a > 0) out.push({ ...rest, t: t.slice(0, a) });
      out.push({ ...rest, t: t.slice(a, a + length), mention: { page: { _0: pageID } } });
      if (a + length < t.length) out.push({ ...rest, t: t.slice(a + length) });
      done = true;
    } else out.push(r);
    offset = end;
  }
  if (!done) return false;
  store.transact("Link mention", (tx) => tx.update(blockID, (x: Block) => { x.text = out as RichText; }));
  return true;
}
