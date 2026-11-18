// BSD-522 (ADR 0017, Abschnitt „Herkunft“): Wer hat eine Seite, wer einen Block geschrieben? Nur Datenmodell und
// Regeln, keine Anzeige. Alle Felder sind optional (Alt-Daten und Importe bleiben leer = unbekannt); Parsen und
// Zurückschreiben alter Records ändert nichts.
//
// - Seite (`page`, `databasePage`): `origin` = human | ai | reviewed | mixed.
// - Block: `author` = Kennung eines Autors aus `workspace.authors` (kind, name, model?). Der Zeitpunkt ist
//   `updatedAt` des Blocks. Ein leerer `author` heißt: der Mensch aus `updatedBy` (oder unbekannt) – so kostet das
//   Feld bei Blöcken, die Menschen schreiben, nichts.
// - Kennungen sind deterministisch (Art + Name + Modell), damit zwei Geräte denselben Agenten gleich nennen und ein
//   verlorener Tabelleneintrag (Last-Writer-Wins am Workspace-Record) die Art nicht mitnimmt: das Präfix sagt sie.
import type { Block } from "./records.js";
import { ENUMS } from "./schema.js";

export const PAGE_ORIGINS = ENUMS.PageOrigin;
export type PageOrigin = (typeof PAGE_ORIGINS)[number];
export const AUTHOR_KINDS = ["agent", "guest", "user"] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

/** Ein Eintrag der Autoren-Tabelle (`workspace.authors`). */
export interface Author {
  kind: AuthorKind;
  name: string;
  /** Modell eines Agenten, wenn bekannt (z. B. „claude-…“). */
  model?: string;
}

const PREFIX: Record<AuthorKind, string> = { agent: "a-", guest: "g-", user: "u-" };

/** FNV-1a (32 Bit) in Basis 36 – kurz und stabil, kein Kryptohash nötig (Kennung, kein Geheimnis). */
function fnv36(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Kennung eines Autors: Präfix der Art + Hash aus Name und Modell (Groß-/Kleinschreibung und Ränder egal). */
export function authorID(a: Author): string {
  return PREFIX[a.kind] + fnv36(`${a.name.trim().toLowerCase()}\u0000${(a.model ?? "").trim().toLowerCase()}`);
}

/** Art eines Autors aus seiner Kennung (auch ohne Tabelleneintrag). */
export function authorKindOf(id: string | undefined): AuthorKind | undefined {
  if (!id) return undefined;
  for (const k of AUTHOR_KINDS) if (id.startsWith(PREFIX[k])) return k;
  return undefined;
}

/** Bekannter Herkunftswert? Unbekannte Werte einer neueren Version bleiben erhalten, zählen hier aber nicht. */
export function isPageOrigin(v: unknown): v is PageOrigin {
  return typeof v === "string" && (PAGE_ORIGINS as readonly string[]).includes(v);
}

/** Abgelehnte Änderung der Herkunft (z. B. ein Agent will „human“ setzen). */
export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceError";
  }
}

/** Wer schreibt: `undefined` = der Mensch am Gerät (normaler Fall in der App). */
export type Actor = Author | undefined;

const actorKind = (actor: Actor): AuthorKind => actor?.kind ?? "user";

/**
 * Darf `actor` die Herkunft einer Seite ausdrücklich auf `next` setzen? Agenten nur „ai“, „reviewed“ nur der
 * Nutzer selbst (kein Gast, kein Agent). Wirft `ProvenanceError`.
 */
export function checkOriginChange(next: string | undefined, actor: Actor): void {
  const kind = actorKind(actor);
  if (next !== undefined && !isPageOrigin(next)) throw new ProvenanceError(`Unknown page origin “${next}”.`);
  if (kind === "agent" && next !== "ai") throw new ProvenanceError("Agents can only mark a page as written by AI.");
  if (next === "reviewed" && kind !== "user") throw new ProvenanceError("Only the user can mark a page as reviewed.");
}

/**
 * Herkunft einer Seite nach einer Änderung an ihrem Inhalt (automatisch, ohne Nachfrage):
 * - Agent legt die Seite an oder schreibt in eine „ai“-Seite → „ai“; in jede andere Seite (auch unbekannte) → „mixed“.
 * - Mensch ändert eine „ai“-Seite → „mixed“; sonst bleibt die Herkunft, wie sie ist (auch leer: neue Seiten und
 *   Importe bleiben unbekannt, bis jemand sie ausdrücklich setzt).
 * - Gast wie Mensch.
 */
export function originAfterEdit(current: string | undefined, actor: Actor, created: boolean): string | undefined {
  if (actorKind(actor) === "agent") return (created && current === undefined) || current === "ai" ? "ai" : "mixed";
  return current === "ai" ? "mixed" : current;
}

/** Hat sich der Inhalt eines Blocks geändert (nicht nur Lage, Papierkorb oder Stempel)? */
export function contentChanged(before: Block | undefined, after: Block): boolean {
  if (!before) return true;
  return before.type !== after.type || !same(before.text, after.text) || !same(before.props, after.props) || !same(before.values, after.values);
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
