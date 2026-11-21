// Quick-Find- und Volltextsuche (Titel, Inhalt, Zeilenwerte), portiert aus BasedCore Search/SearchCorpus.swift und
// Search/SearchEngine.swift (BSD-137, BSD-157). Texte liegen gefaltet im Index (Groß/klein und Akzente egal).
//
// `SearchIndex` ist reines TypeScript ohne DOM und ohne Store: er hält eine eigene Kopie der Blöcke und Datenbanken
// und wird mit Records gefüttert (`load`, `apply`). Damit läuft er im Hauptthread (`attachSearchIndex(store)`) oder
// in einem Worker (`searchDeltaFrom`/`observeSearchDeltas` im Hauptthread, `handleSearchMessage` im Worker).
// Änderungen werden inkrementell eingearbeitet: neu berechnet werden nur die geänderten Blöcke, bei Struktur-
// änderungen (Eltern, Reihenfolge, Papierkorb, Typ) ihr Teilbaum und Blöcke, die sie erwähnen.
//
// Anders als Swift ist das Ergebnis stabil: Inhalts-Snippet aus dem ersten passenden Block in Dokumentreihenfolge,
// Zeilen-Snippet über die Werte nach Property-ID, Gleichstand nach pageID. Verifiziert über fixtures/search.
import type { Block, Database, PropertyValue, RichText, WireRecord } from "../model/records.js";
import { placeDisplay, richPlain } from "../query/engine.js";
import { fromJSDate } from "../query/value.js";
import { graphemes } from "../graphemes.js";
import type { RecordKeyString, StoreChange, WorkspaceStore } from "../store/store.js";

export interface SearchHit {
  /** Kein genauer Treffer: über einen Tippfehler, eine andere Wortform oder mit einem fehlenden Begriff gefunden. */
  approx?: true;
  pageID: string;
  score: number;
  /** Passender Inhaltstext (fehlt, wenn nur der Titel passt). */
  snippet?: string;
  blockID?: string;
}

export interface SearchFilters {
  titleOnly?: boolean;
  inPage?: string;
  createdBy?: string;
  /** Swift-Datum (Sekunden seit 2001). */
  editedAfter?: number;
  editedBefore?: number;
}

export type SearchSort = "bestMatch" | "lastEditedNewest" | "lastEditedOldest" | "createdNewest" | "createdOldest";

export interface SearchOptions {
  filters?: SearchFilters;
  sort?: SearchSort;
  limit?: number;
  /** Swift-Datum für die Aktualitäts-Punkte (Standard: jetzt). */
  now?: number;
  /** Wird regelmäßig gefragt; `true` bricht ab (Ergebnis `undefined`), z. B. bei einer neueren Eingabe. */
  isCancelled?: () => boolean;
  /**
   * BSD-425: Quick Find „findet mehr“ – zusätzlich zu den Treffern wie Swift (Fixtures unverändert): Begriffe über
   * Titel und mehrere Blöcke einer Seite verteilt, Auswahl-/Status-Optionen, Zahlen und Dateinamen in Zeilen,
   * Dateinamen und Links in Blöcken, ein Tippfehler bzw. Plural-s in Titelwörtern. Diese Treffer stehen hinter
   * den genauen (niedrigere Punkte).
   */
  extended?: boolean;
}

/** BSD-425: Punkte der zusätzlichen Treffer (unter Inhalt 20 und Zeile 15 aus der Swift-Suche). */
export const EXTENDED_SCORES = { spread: 12, extraContent: 18, extraRow: 14, fuzzyTitle: 8, joinedTitle: 7, fuzzy: 6 } as const;

/** Was die Suche aus dem Arbeitsbereich braucht (ein `WorkspaceStore` passt). */
export interface SearchSource {
  readonly blocks: ReadonlyMap<string, Block>;
  readonly databases: ReadonlyMap<string, Database>;
}

/** Änderungen für den Index (strukturiert klonbar, also auch per `postMessage`). `deletions`: `block:<id>`, `database:<id>`. */
export interface SearchDelta {
  upserts: WireRecord[];
  deletions: RecordKeyString[];
}



/** Groß/klein und Akzente falten (Swift `folding([.caseInsensitive, .diacriticInsensitive])`). */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC").toLowerCase().replaceAll("ß", "ss");
}

const isPageLike = (b: Block) => b.type === "page" || b.type === "databasePage";

const WORD_CHAR = /[\p{L}\p{N}]/u;
const ALL_WORD_CHARS = /^[\p{L}\p{N}]+$/u;

/** Beginnt in `title` ein Wort (Buchstaben/Ziffern) mit `t`? Wie `split(/[^\p{L}\p{N}]+/u).some(startsWith)`, ohne zu teilen (BSD-280). */
function wordStartsWith(title: string, t: string): boolean {
  if (!ALL_WORD_CHARS.test(t)) return title.split(/[^\p{L}\p{N}]+/u).some((w) => w.length > 0 && w.startsWith(t));
  for (let i = title.indexOf(t); i >= 0; i = title.indexOf(t, i + 1)) {
    if (i === 0) return true;
    let j = i - 1;
    const c = title.charCodeAt(j);
    if (c >= 0xdc00 && c <= 0xdfff && j > 0) j -= 1; // Ersatzpaar: Zeichen davor ganz ansehen
    if (!WORD_CHAR.test(String.fromCodePoint(title.codePointAt(j)!))) return true;
  }
  return false;
}

function titleScore(title: string, q: string, terms: string[]): number | undefined {
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  // Alle weiteren Stufen verlangen jeden Begriff im Titel – billig vorab prüfen (BSD-280).
  if (!terms.every((t) => title.includes(t))) return undefined;
  if (terms.every((t) => wordStartsWith(title, t))) return 60;
  if (title.includes(q)) return 45;
  if (terms.every((t) => title.includes(t))) return 35;
  return undefined;
}

/** Ausschnitt um den ersten Treffer (Swift `SearchEngine.snippet`). */
export function snippet(text: string, folded: string, term: string): string {
  const i = folded.indexOf(term);
  const chars = graphemes(text);
  if (i < 0) return chars.slice(0, 120).join("");
  const offset = graphemes(folded.slice(0, i)).length;
  const start = Math.max(0, offset - 40);
  const end = Math.min(chars.length, offset + graphemes(term).length + 80);
  if (start >= end) return chars.slice(0, 120).join("");
  return (start > 0 ? "…" : "") + chars.slice(start, end).join("") + (end < chars.length ? "…" : "");
}

// MARK: Hierarchie-Helfer über eine Quelle (Swift `SearchCorpus.Snapshot`)

function parentBlock(src: SearchSource, b: Block): Block | undefined {
  const p = b.parent;
  if (p === "w") return undefined;
  if (p.startsWith("b:")) return src.blocks.get(p.slice(2));
  const owner = src.databases.get(p.slice(2))?.blockID;
  return owner === undefined ? undefined : src.blocks.get(owner);
}

function isTrashedIn(src: SearchSource, id: string): boolean {
  let cur = src.blocks.get(id);
  for (let n = 0; cur && n < 1000; n++) {
    if (cur.trashedAt !== undefined) return true;
    const p = cur.parent;
    if (p === "w") return false;
    if (p.startsWith("b:")) cur = src.blocks.get(p.slice(2));
    else {
      const owner = src.databases.get(p.slice(2))?.blockID;
      if (owner === undefined) return true;
      cur = src.blocks.get(owner);
    }
    if (!cur) return true;
  }
  return false;
}

function containingPage(src: SearchSource, id: string): string | undefined {
  let cur = src.blocks.get(id);
  for (let n = 0; cur && n < 1000; n++) {
    if (isPageLike(cur)) return cur.id;
    cur = parentBlock(src, cur);
  }
  return undefined;
}

function isDescendant(src: SearchSource, id: string, ancestor: string): boolean {
  let p = src.blocks.get(id)?.parent;
  for (let n = 0; p && n < 10_000; n++) {
    if (p === "w") return false;
    if (p.startsWith("b:")) {
      const pid = p.slice(2);
      if (pid === ancestor) return true;
      p = src.blocks.get(pid)?.parent;
    } else {
      const owner = src.databases.get(p.slice(2))?.blockID;
      if (!owner) return false;
      if (owner === ancestor) return true;
      p = src.blocks.get(owner)?.parent;
    }
  }
  return false;
}

const ownsDatabase = (src: SearchSource, b: Block) =>
  b.props?.databaseID !== undefined && src.databases.get(b.props.databaseID)?.blockID === b.id;

/** Titel wie Swift `title(of:)` (Datenbank-Container: Titel der Datenbank). */
export function searchTitle(src: SearchSource, id: string): string {
  const b = src.blocks.get(id);
  if (!b) return "Untitled";
  if ((b.type === "databasePage" || b.type === "databaseInline") && b.props?.databaseID) {
    const db = src.databases.get(b.props.databaseID);
    if (db) {
      const t = richPlain(db.title);
      return t ? t : "Untitled";
    }
  }
  const t = richPlain(b.text).replace(/^[ \t]+|[ \t]+$/g, "");
  return t ? t : "Untitled";
}

function mentionTarget(mention: unknown): string | undefined {
  if (!mention || typeof mention !== "object") return undefined;
  const page = (mention as { page?: { _0?: unknown } }).page;
  return page && typeof page._0 === "string" ? page._0 : undefined;
}

function mentionTargets(t: RichText | undefined): string[] {
  if (t === undefined || typeof t === "string") return [];
  const out: string[] = [];
  for (const r of t) {
    const m = mentionTarget(r.mention);
    if (m !== undefined) out.push(m);
  }
  return out;
}

function resolvingMentions(src: SearchSource, t: RichText | undefined): string {
  if (t === undefined || typeof t === "string") return t ?? "";
  return t.map((r) => {
    const m = mentionTarget(r.mention);
    return m !== undefined && src.blocks.has(m) ? searchTitle(src, m) : r.t ?? "";
  }).join("");
}

/** Text eines Nicht-Seiten-Blocks: Text (Erwähnungen mit aktuellem Titel), Tabellenzellen, Bildunterschrift, Transkript. */
export function contentText(src: SearchSource, b: Block): string {
  let text = resolvingMentions(src, b.text);
  if (b.props?.cells) text += " " + b.props.cells.map(richPlain).join(" ");
  if (b.props?.caption !== undefined) text += " " + richPlain(b.props.caption);
  if (b.props?.segments) text += " " + b.props.segments.filter((s) => s.p !== true).map((s) => s.t).join(" ");
  return text;
}

/** Text-artige Werte einer Zeile (Property-IDs sortiert, damit das Snippet stabil ist). */
export function rowText(b: Block): string {
  const values = b.values ?? {};
  return Object.keys(values).sort().flatMap((k) => {
    const v = values[k] as PropertyValue;
    const [kind] = Object.keys(v);
    const x = (v as Record<string, { _0: unknown }>)[kind!]?._0;
    switch (kind) {
      case "text": return [richPlain(x as Block["text"])];
      case "url": case "email": case "phone": return [x as string];
      case "place": return [placeDisplay(x as string)];
      default: return [];
    }
  }).join(" ");
}

/** BSD-425: weitere Zeilenwerte für Quick Find – Optionsnamen (Auswahl, Status, Mehrfachauswahl), Zahlen, Dateinamen. */
export function rowExtraText(b: Block, db: Database | undefined, src?: SearchSource): string {
  const values = b.values ?? {};
  const optionName = (prop: string, id: string) => db?.properties.find((p) => p.id === prop)?.options?.find((o) => o.id === id)?.name ?? "";
  return Object.keys(values).sort().flatMap((k) => {
    const v = values[k] as PropertyValue;
    const [kind] = Object.keys(v);
    const x = (v as Record<string, { _0: unknown }>)[kind!]?._0;
    switch (kind) {
      case "select": case "status": return typeof x === "string" ? [optionName(k, x)] : [];
      case "multiSelect": return Array.isArray(x) ? x.map((id) => optionName(k, String(id))) : [];
      case "number": return typeof x === "number" && Number.isFinite(x) ? [String(x)] : [];
      case "files": return Array.isArray(x) ? x.map((f) => (f && typeof f === "object" && typeof (f as { name?: unknown }).name === "string" ? (f as { name: string }).name : "")) : [];
      // Eine Zeile findet man auch über das, worauf sie zeigt: Titel der verknüpften Zeilen und Seiten, Personen.
      case "relation": return src && Array.isArray(x) ? x.map((id) => (typeof id === "string" && src.blocks.has(id) ? searchTitle(src, id) : "")) : [];
      case "person": return Array.isArray(x) ? x.filter((p): p is string => typeof p === "string") : [];
      default: return [];
    }
  }).concat(src && db ? [richPlain(db.title)] : []).filter(Boolean).join(" ");
}

/** BSD-425: Dateiname und Link eines Blocks (Datei, Bild, Lesezeichen, Embed) – Swift sucht hier nicht. */
export function blockExtraText(b: Block): string {
  const parts: string[] = [];
  if (b.props?.asset?.name) parts.push(b.props.asset.name);
  if (b.props?.url) parts.push(b.props.url);
  const title = (b.props as { title?: unknown } | undefined)?.title;
  if (typeof title === "string") parts.push(title);
  return parts.join(" ");
}

/** Seiten und Zeilen, auf die die Relationen einer Zeile zeigen. */
export function relationTargets(b: Block): string[] {
  const out: string[] = [];
  for (const v of Object.values(b.values ?? {})) {
    const x = (v as { relation?: { _0?: unknown } }).relation?._0;
    if (Array.isArray(x)) for (const id of x) if (typeof id === "string") out.push(id);
  }
  return out;
}

/**
 * Abstand zweier Wörter in Tippfehlern (fehlend, zusätzlich, falsch, zwei vertauscht), höchstens `max`; sonst
 * `max + 1`. Für die Suche mit Tippfehlern im ganzen Text.
 */
const ROWS = [new Int16Array(64), new Int16Array(64), new Int16Array(64)];
export function typoDistance(a: string, b: string, max: number): number {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max || lb >= 63) return max + 1;
  // Drei wiederverwendete Zeilen statt neuer Arrays je Vergleich (das Wörterbuch hat schnell 100 000 Wörter).
  let prev2 = ROWS[0]!, prev = ROWS[1]!, cur = ROWS[2]!;
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let best = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1);
      let d = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (ca === cb ? 0 : 1));
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) d = Math.min(d, prev2[j - 2]! + 1);
      cur[j] = d;
      if (d < best) best = d;
    }
    if (best > max) return max + 1;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return Math.min(prev[lb]!, max + 1);
}

/** Wie viele Tippfehler ein Begriff haben darf: kurze genau, ab 4 Zeichen einer, ab 8 zwei. Ziffern immer genau. */
export const typoBudget = (term: string): number => (/\p{N}/u.test(term) || term.length < 3 ? 0 : term.length < 8 ? 1 : 2);
/** Drei Buchstaben: nur zwei vertauschte („mti“ → „mit“) – ein beliebiger Fehler träfe bei so kurzen Wörtern fast alles. */
const swapped = (a: string, b: string) => a.length === 3 && b.length === 3 && a !== b && ((a[0] === b[1] && a[1] === b[0] && a[2] === b[2]) || (a[0] === b[0] && a[1] === b[2] && a[2] === b[1]));

const WORDS = /[^\p{L}\p{N}]+/u;
// Wörter mit Ziffern (Nummern, IDs, Daten) gehören nicht ins Wörterbuch: sie werden nie ungefähr gesucht, wären aber
// in großen Workspaces der größte Teil davon.
const vocabWords = (folded: string) => folded.split(WORDS).filter((w) => w.length >= 3 && w.length <= 40 && !/\p{N}/u.test(w));

/** BSD-425: Wort ≈ Begriff – höchstens eine Änderung (fehlend, zusätzlich, falsch, vertauscht); kurze Begriffe genau. */
export function nearWord(word: string, term: string): boolean {
  if (word === term) return true;
  const lw = word.length, lt = term.length;
  if (lt < 4 || Math.abs(lw - lt) > 1) return false;
  let i = 0;
  while (i < lw && i < lt && word[i] === term[i]) i++;
  if (lw === lt) {
    if (word.slice(i + 1) === term.slice(i + 1)) return true; // ersetzt
    return i + 1 < lw && word[i] === term[i + 1] && word[i + 1] === term[i] && word.slice(i + 2) === term.slice(i + 2); // vertauscht
  }
  return lw > lt ? word.slice(i + 1) === term.slice(i) : word.slice(i) === term.slice(i + 1);
}

// MARK: Index

interface ContentEntry {
  blockID: string;
  page: string;
  folded: string;
  /** Weg von der Seite zum Block: (sk, id) je Ebene – vergleichbar in Dokumentreihenfolge. */
  path: string[];
}

/**
 * Die ersten `k` Einträge nach `cmp`, in dieser Reihenfolge – dasselbe wie `[...items].sort(cmp).slice(0, k)`, wenn
 * `cmp` streng ordnet, aber ohne alles zu sortieren: meist ein Vergleich je Eintrag (mit dem bisher k-ten).
 */
export function firstK<T>(items: readonly T[], k: number, cmp: (a: T, b: T) => number): T[] {
  const top: T[] = [];
  if (k <= 0) return top;
  for (const x of items) {
    if (top.length === k && cmp(x, top[k - 1]!) >= 0) continue;
    let lo = 0, hi = top.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmp(top[mid]!, x) <= 0) lo = mid + 1;
      else hi = mid;
    }
    top.splice(lo, 0, x);
    if (top.length > k) top.pop();
  }
  return top;
}

function comparePaths(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length - b.length;
}

const isRowBlock = (b: Block) => b.parent.startsWith("d:");

/** Suchindex. Pure Datenstruktur: ohne DOM, ohne Store – im Worker benutzbar. */
export class SearchIndex implements SearchSource {
  readonly blocks = new Map<string, Block>();
  readonly databases = new Map<string, Database>();
  private readonly children = new Map<string, Set<string>>();
  /** Erwähnungsziel → Blöcke, deren Text es erwähnt. */
  private readonly mentionedBy = new Map<string, Set<string>>();
  private readonly mentionsOf = new Map<string, string[]>();
  private readonly titles = new Map<string, string>();
  private readonly contentEntries = new Map<string, ContentEntry>();
  private readonly rows = new Map<string, string>();
  /** BSD-425: Zusatztexte für `extended` (Dateinamen/Links in Blöcken, Optionen/Zahlen in Zeilen). */
  private readonly extraEntries = new Map<string, ContentEntry>();
  private readonly extraRows = new Map<string, string>();
  /** BSD-425: Wörter der Titel (für die Tippfehler-Suche, einmal beim Einarbeiten zerlegt). */
  private readonly titleWords = new Map<string, string[]>();
  /** Zählt jede Änderung (wie Swift `revision`). */
  revision = 0;

  /** Index über alle Records (z. B. `store.allRecords()` oder ein Archiv). */
  static fromRecords(records: Iterable<WireRecord>): SearchIndex {
    const index = new SearchIndex();
    index.apply({ upserts: [...records], deletions: [] });
    return index;
  }

  /** Index über einen Store-Stand (Kopie; spätere Änderungen über `apply` oder `attachSearchIndex`). */
  static fromSource(src: SearchSource): SearchIndex {
    const index = new SearchIndex();
    index.load(src);
    return index;
  }

  /** Ersetzt den Inhalt durch einen vollständigen Stand. */
  load(src: SearchSource) {
    for (const m of [this.blocks, this.databases, this.children, this.mentionedBy, this.mentionsOf, this.titles, this.contentEntries, this.rows, this.extraEntries, this.extraRows, this.titleWords]) m.clear();
    this.vocabulary.clear();
    for (const d of src.databases.values()) this.databases.set(d.id, d);
    for (const b of src.blocks.values()) this.putBlock(b);
    for (const id of this.blocks.keys()) this.recompute(id);
    this.revision += 1;
  }

  get entryCount() {
    return this.titles.size + this.contentEntries.size + this.rows.size;
  }

  /** Inhaltseinträge in Dokumentreihenfolge innerhalb jeder Seite (für Tests und Fixtures). */
  get contents(): readonly ContentEntry[] {
    return [...this.contentEntries.values()];
  }

  /** Arbeitet Änderungen ein (Records anderer Arten werden übergangen). */
  apply(delta: SearchDelta) {
    const dirty = new Set<string>();
    const subtree = (root: string) => {
      const stack = [root];
      while (stack.length) {
        const id = stack.pop()!;
        for (const c of this.children.get("b:" + id) ?? []) if (!dirty.has(c)) { dirty.add(c); stack.push(c); }
        const b = this.blocks.get(id);
        const db = b?.props?.databaseID;
        if (b && db !== undefined && this.databases.get(db)?.blockID === id) {
          for (const r of this.children.get("d:" + db) ?? []) if (!dirty.has(r)) { dirty.add(r); stack.push(r); }
        }
      }
    };
    const mentioning = (id: string) => { for (const m of this.mentionedBy.get(id) ?? []) dirty.add(m); };
    const databaseRows = (dbID: string) => {
      for (const r of this.children.get("d:" + dbID) ?? []) { dirty.add(r); subtree(r); }
    };
    for (const r of delta.upserts) {
      if (r.kind === "block") {
        const b = r.data;
        const old = this.blocks.get(b.id);
        this.putBlock(b);
        dirty.add(b.id);
        mentioning(b.id);
        const structural = !old || old.parent !== b.parent || old.sk !== b.sk || old.type !== b.type ||
          old.trashedAt !== b.trashedAt || old.props?.databaseID !== b.props?.databaseID;
        if (structural) subtree(b.id);
      } else if (r.kind === "database") {
        const d = r.data;
        const old = this.databases.get(d.id);
        this.databases.set(d.id, d);
        for (const owner of new Set([d.blockID, old?.blockID])) {
          if (owner === undefined) continue;
          dirty.add(owner);
          mentioning(owner);
        }
        // BSD-425: Optionsnamen stehen in der Datenbank – ihre Zeilen neu (nur bei geänderten Properties)
        // … und der Datenbankname gehört zum Suchtext ihrer Zeilen.
        if (!old || old.blockID !== d.blockID || old.properties !== d.properties || JSON.stringify(old.title) !== JSON.stringify(d.title)) databaseRows(d.id);
      }
    }
    for (const key of delta.deletions) {
      const i = key.indexOf(":");
      const kind = key.slice(0, i), id = key.slice(i + 1);
      if (kind === "block") {
        if (!this.blocks.has(id)) continue;
        subtree(id);
        mentioning(id);
        this.removeBlock(id);
        dirty.add(id);
      } else if (kind === "database") {
        const old = this.databases.get(id);
        if (!old) continue;
        databaseRows(id);
        this.databases.delete(id);
        dirty.add(old.blockID);
        mentioning(old.blockID);
      }
    }
    for (const id of dirty) this.recompute(id);
    if (delta.upserts.length > 0 || delta.deletions.length > 0) this.revision += 1;
  }

  private putBlock(b: Block) {
    const old = this.blocks.get(b.id);
    if (old && old.parent !== b.parent) this.children.get(old.parent)?.delete(b.id);
    this.blocks.set(b.id, b);
    let set = this.children.get(b.parent);
    if (!set) this.children.set(b.parent, (set = new Set()));
    set.add(b.id);
    // Relationen zählen wie Erwähnungen: ändert sich der Titel des Ziels, wird die Zeile neu eingearbeitet.
    const targets = relationTargets(b);
    this.setMentions(b.id, targets.length ? [...mentionTargets(b.text), ...targets] : mentionTargets(b.text));
  }

  private removeBlock(id: string) {
    const old = this.blocks.get(id);
    if (!old) return;
    this.children.get(old.parent)?.delete(id);
    this.blocks.delete(id);
    this.setMentions(id, []);
  }

  private setMentions(id: string, targets: string[]) {
    for (const t of this.mentionsOf.get(id) ?? []) this.mentionedBy.get(t)?.delete(id);
    if (targets.length === 0) { this.mentionsOf.delete(id); return; }
    this.mentionsOf.set(id, targets);
    for (const t of targets) {
      let set = this.mentionedBy.get(t);
      if (!set) this.mentionedBy.set(t, (set = new Set()));
      set.add(id);
    }
  }

  private pathFromPage(id: string, page: string): string[] {
    const out: string[] = [];
    let cur = this.blocks.get(id);
    for (let n = 0; cur && cur.id !== page && n < 1000; n++) {
      out.push(cur.sk + "\u0000" + cur.id);
      cur = parentBlock(this, cur);
    }
    return out.reverse();
  }

  /** Einträge eines Blocks neu (Swift `SearchCorpus.build` für einen Block). */
  private recompute(id: string) {
    for (const old of [this.titles.get(id), this.contentEntries.get(id)?.folded, this.rows.get(id), this.extraEntries.get(id)?.folded, this.extraRows.get(id)]) {
      if (old) this.countWords(old, -1);
    }
    this.recomputeEntries(id);
    for (const cur of [this.titles.get(id), this.contentEntries.get(id)?.folded, this.rows.get(id), this.extraEntries.get(id)?.folded, this.extraRows.get(id)]) {
      if (cur) this.countWords(cur, 1);
    }
  }

  /** Wörter (ab 4 Zeichen) aller Einträge mit ihrer Häufigkeit – das Wörterbuch für die Suche mit Tippfehlern. */
  private readonly vocabulary = new Map<string, number>();
  private countWords(folded: string, by: 1 | -1) {
    for (const w of vocabWords(folded)) {
      const n = (this.vocabulary.get(w) ?? 0) + by;
      if (n > 0) this.vocabulary.set(w, n);
      else this.vocabulary.delete(w);
    }
  }

  /**
   * Wörter aus dem Workspace, die ein Begriff gemeint haben könnte: mit Tippfehlern (auch wenn erst der Anfang des
   * Wortes getippt ist) oder in anderer Wortform (gleicher Wortstamm). Die nächsten zuerst, häufigere vor seltenen.
   */
  alternatives(term: string, max = 6): { word: string; distance: number }[] {
    const budget = typoBudget(term);
    if (budget === 0) return [];
    const out: { word: string; distance: number; n: number }[] = [];
    const lt = term.length;
    if (lt === 3) {
      for (const [word, n] of this.vocabulary) if (swapped(word, term)) out.push({ word, distance: 1, n });
      out.sort((a, b) => b.n - a.n || (a.word < b.word ? -1 : 1));
      return out.slice(0, max).map(({ word, distance }) => ({ word, distance }));
    }
    for (const [word, n] of this.vocabulary) {
      if (word.length < 4 || word.includes(term)) continue; // kurze nie ungefähr; enthaltene findet schon die genaue Suche
      const lw = word.length;
      let d = budget + 1;
      if (lw >= lt - budget) {
        d = lw <= lt + budget ? typoDistance(word, term, budget) : budget + 1;
        // erst der Anfang getippt: gegen den Wortanfang gleicher Länge prüfen
        if (d > budget && lw > lt) d = Math.min(typoDistance(word.slice(0, lt), term, budget), typoDistance(word.slice(0, lt + 1), term, budget));
      }
      if (d > budget && lt >= 6 && lw >= 6) {
        // andere Wortform: langer gemeinsamer Anfang (collection/collected, Rechnung/Rechnungen)
        let i = 0;
        while (i < lt && i < lw && word[i] === term[i]) i++;
        if (i >= Math.max(5, Math.ceil(Math.min(lt, lw) * 0.7))) d = budget + 0.5;
      }
      if (d <= budget + 0.5) out.push({ word, distance: d, n });
    }
    out.sort((a, b) => a.distance - b.distance || b.n - a.n || (a.word < b.word ? -1 : 1));
    return out.slice(0, max).map(({ word, distance }) => ({ word, distance }));
  }

  private recomputeEntries(id: string) {
    this.titles.delete(id);
    this.contentEntries.delete(id);
    this.rows.delete(id);
    this.extraEntries.delete(id);
    this.extraRows.delete(id);
    this.titleWords.delete(id);
    const b = this.blocks.get(id);
    if (!b) return;
    let live: boolean | undefined;
    const isLive = () => (live ??= !isTrashedIn(this, id));
    if ((isPageLike(b) || (b.type === "databaseInline" && ownsDatabase(this, b))) && isLive()) {
      const t = fold(searchTitle(this, id));
      this.titles.set(id, t);
      this.titleWords.set(id, t.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    }
    if (!isPageLike(b) && b.trashedAt === undefined) {
      const text = contentText(this, b);
      const page = text ? containingPage(this, id) : undefined;
      if (text && page !== undefined && this.blocks.has(page) && !isTrashedIn(this, page)) {
        this.contentEntries.set(id, { blockID: id, page, folded: fold(text), path: this.pathFromPage(id, page) });
      }
      const extra = blockExtraText(b);
      const extraPage = extra ? page ?? containingPage(this, id) : undefined;
      if (extra && extraPage !== undefined && this.blocks.has(extraPage) && !isTrashedIn(this, extraPage)) {
        this.extraEntries.set(id, { blockID: id, page: extraPage, folded: fold(extra), path: this.pathFromPage(id, extraPage) });
      }
    }
    if (isRowBlock(b) && b.values && Object.keys(b.values).length > 0 && isLive()) {
      const text = rowText(b);
      if (text) this.rows.set(id, fold(text));
      const extra = rowExtraText(b, this.databases.get(b.parent.slice(2)), this);
      if (extra) this.extraRows.set(id, fold(extra));
    }
  }

  /** Suche; `undefined`, wenn `isCancelled` abbricht. Eine leere Anfrage liefert keine Treffer (die Shell zeigt dann zuletzt besuchte Seiten). */
  run(query: string, opts: SearchOptions = {}): SearchHit[] | undefined {
    const filters = opts.filters ?? {}, sort = opts.sort ?? "bestMatch", limit = opts.limit ?? 50;
    const now = opts.now ?? fromJSDate(new Date());
    const cancelled = opts.isCancelled ?? (() => false);
    const q = fold(query.trim());
    if (!q) return [];
    const terms = q.split(" ").filter((t) => t.length > 0);
    const blocks = this.blocks;
    const allowed = (page: Block) => {
      if (page.props?.isTemplate === true) return false;
      if (filters.createdBy !== undefined && page.createdBy !== filters.createdBy) return false;
      if (filters.editedAfter !== undefined && page.updatedAt < filters.editedAfter) return false;
      if (filters.editedBefore !== undefined && page.updatedAt > filters.editedBefore) return false;
      if (filters.inPage !== undefined && page.id !== filters.inPage && !isDescendant(this, page.id, filters.inPage)) return false;
      return true;
    };
    const recency = (b: Block) => Math.max(0, 10 - (now - b.updatedAt) / 86_400 / 3);
    const hits = new Map<string, SearchHit>();
    // BSD-280: Ausschnitte erst für die zurückgegebenen Treffer bauen (sie ändern die Reihenfolge nicht); bei „p“
    // in 27 000 Einträgen kostete das sonst den Großteil der Suche.
    const snippetOf = new Map<string, () => string>();
    let n = 0;
    const tick = () => (++n & 4095) === 0 && cancelled();
    for (const [id, folded] of this.titles) {
      if (tick()) return undefined;
      // Erst der Text (passt meist nicht), dann Block und Filter – gleiches Ergebnis, ein Bruchteil der Arbeit.
      const s = titleScore(folded, q, terms);
      if (s === undefined) continue;
      const b = blocks.get(id);
      if (b && allowed(b)) hits.set(id, { pageID: id, score: s + recency(b) });
    }
    if (!filters.titleOnly) {
      // Erster passender Block je Seite in Dokumentreihenfolge.
      const firstMatch = new Map<string, ContentEntry>();
      for (const e of this.contentEntries.values()) {
        if (tick()) return undefined;
        if (!terms.every((t) => e.folded.includes(t))) continue;
        const best = firstMatch.get(e.page);
        if (!best || comparePaths(e.path, best.path) < 0) firstMatch.set(e.page, e);
      }
      for (const [page, e] of firstMatch) {
        const pb = blocks.get(page), b = blocks.get(e.blockID);
        if (!pb || !b || !allowed(pb)) continue;
        snippetOf.set(page, () => snippet(contentText(this, b), e.folded, terms[0]!));
        const h = hits.get(page);
        if (h) {
          h.blockID = e.blockID;
          h.score += 5;
        } else {
          hits.set(page, { pageID: page, score: 20 + recency(pb), blockID: e.blockID });
        }
      }
      for (const [id, folded] of this.rows) {
        if (tick()) return undefined;
        if (!terms.every((t) => folded.includes(t)) || hits.has(id)) continue;
        const b = blocks.get(id);
        if (!b || !allowed(b)) continue;
        hits.set(id, { pageID: id, score: 15 });
        snippetOf.set(id, () => snippet(rowText(b), folded, terms[0]!));
      }
    }
    if (opts.extended && terms.length > 0 && terms.length <= 30) {
      if (this.extendedHits(q, terms, hits, snippetOf, allowed, recency, filters.titleOnly === true, limit, tick) === undefined) return undefined;
    }
    let out = [...hits.values()];
    // BSD-280: Bei vielen Treffern nur die Kandidaten voll sortieren, deren Punktzahl für die ersten `limit` reicht
    // (Gleichstände an der Grenze bleiben alle drin – das Ergebnis ist dasselbe wie bei voller Sortierung).
    if (sort === "bestMatch" && limit > 0 && out.length > limit * 4) {
      const scores = Float64Array.from(out, (h) => h.score).sort();
      const cut = scores[scores.length - limit]!;
      out = out.filter((h) => h.score >= cut);
    }
    const date = (h: SearchHit, created: boolean) => { const b = blocks.get(h.pageID); return b ? (created ? b.createdAt : b.updatedAt) : -Infinity; };
    const byId = (a: SearchHit, b: SearchHit) => (a.pageID < b.pageID ? -1 : a.pageID > b.pageID ? 1 : 0);
    const titleCache = new Map<string, string>();
    const title = (id: string) => {
      let t = titleCache.get(id);
      if (t === undefined) titleCache.set(id, (t = searchTitle(this, id)));
      return t;
    };
    const order = (a: SearchHit, b: SearchHit): number => {
      switch (sort) {
        case "bestMatch": {
          if (a.score !== b.score) return b.score - a.score;
          const ta = title(a.pageID), tb = title(b.pageID);
          if (ta !== tb) return ta < tb ? -1 : 1;
          return byId(a, b);
        }
        case "lastEditedNewest": return date(b, false) - date(a, false) || byId(a, b);
        case "lastEditedOldest": return date(a, false) - date(b, false) || byId(a, b);
        case "createdNewest": return date(b, true) - date(a, true) || byId(a, b);
        case "createdOldest": return date(a, true) - date(b, true) || byId(a, b);
      }
    };
    // Gebraucht werden nur die ersten `limit`: bei vielen Treffern (kurze Anfrage, viele gleiche Punkte) nur diese
    // auswählen statt alle zu sortieren – dasselbe Ergebnis (die Ordnung ist streng: zuletzt nach ID).
    const top = limit > 0 && Number.isFinite(limit) && out.length > limit ? firstK(out, limit, order) : out.sort(order).slice(0, limit);
    for (const h of top) {
      const make = snippetOf.get(h.pageID);
      if (make) h.snippet = make();
    }
    return top;
  }

  /**
   * BSD-425: zusätzliche Treffer (siehe `SearchOptions.extended`). Ergänzt `hits`, ändert vorhandene nicht.
   * `undefined` = abgebrochen.
   */
  private extendedHits(q: string, terms: string[], hits: Map<string, SearchHit>, snippetOf: Map<string, () => string>, allowed: (b: Block) => boolean,
    recency: (b: Block) => number, titleOnly: boolean, limit: number, tick: () => boolean): true | undefined {
    const blocks = this.blocks;
    let approx = false;
    const add = (page: string, score: number, blockID?: string, snip?: () => string, withRecency = true) => {
      if (hits.has(page)) return;
      const pb = blocks.get(page);
      if (!pb || !allowed(pb)) return;
      hits.set(page, { pageID: page, score: score + (withRecency ? recency(pb) : 0), ...(blockID ? { blockID } : {}), ...(approx ? { approx: true as const } : {}) });
      if (snip) snippetOf.set(page, snip);
    };
    if (!titleOnly) {
      // Dateinamen/Links in Blöcken und weitere Zeilenwerte, die alle Begriffe enthalten
      for (const e of this.extraEntries.values()) {
        if (tick()) return undefined;
        if (!hits.has(e.page) && terms.every((t) => e.folded.includes(t))) {
          const b = blocks.get(e.blockID);
          add(e.page, EXTENDED_SCORES.extraContent, e.blockID, b ? () => snippet(blockExtraText(b), e.folded, terms[0]!) : undefined);
        }
      }
      for (const [id, folded] of this.extraRows) {
        if (tick()) return undefined;
        if (hits.has(id)) continue;
        const both = (this.rows.get(id) ?? "") + " " + folded;
        if (terms.every((t) => both.includes(t))) {
          const b = blocks.get(id);
          // wie die Zeilen-Treffer der Swift-Suche ohne Aktualitäts-Punkte
          if (b) add(id, EXTENDED_SCORES.extraRow, undefined, () => snippet(rowText(b) + " " + rowExtraText(b, this.databases.get(b.parent.slice(2)), this), both, terms[0]!), false);
        }
      }
      // Begriffe über Titel, Blöcke und Zeilenwerte einer Seite verteilt. Begriff für Begriff (der längste, meist
      // seltenste zuerst): Seiten mit dem ersten Begriff, dann nur noch deren Einträge prüfen (BSD-280: billig).
      if (terms.length > 1) {
        // Ziffern (Nummern, IDs) und lange Begriffe sind selten – zuerst, dann bleiben wenige Kandidaten.
        const rare = (t: string) => (/\p{N}/u.test(t) ? 1000 : 0) + t.length;
        const sorted = [...terms].sort((a, b) => rare(b) - rare(a));
        let cand: Set<string> | undefined;
        const firstEntry = new Map<string, ContentEntry>();
        for (const [k, t] of sorted.entries()) {
          const next = new Set<string>();
          const visit = (page: string, folded: string, entry?: ContentEntry) => {
            if (hits.has(page) || (cand && !cand.has(page))) return;
            if (next.has(page) && (k > 0 || !entry)) return;
            if (!folded.includes(t)) return;
            next.add(page);
            if (k === 0 && entry) {
              const best = firstEntry.get(page);
              if (!best || comparePaths(entry.path, best.path) < 0) firstEntry.set(page, entry);
            }
          };
          for (const [id, folded] of this.titles) { if (tick()) return undefined; visit(id, folded); }
          for (const map of [this.contentEntries, this.extraEntries]) {
            for (const e of map.values()) { if (tick()) return undefined; visit(e.page, e.folded, e); }
          }
          for (const [id, folded] of this.rows) { if (tick()) return undefined; visit(id, folded); }
          for (const [id, folded] of this.extraRows) { if (tick()) return undefined; visit(id, folded); }
          cand = next;
          if (cand.size === 0) break;
        }
        for (const page of cand ?? []) {
          const entry = firstEntry.get(page);
          const b = entry ? blocks.get(entry.blockID) : undefined;
          add(page, EXTENDED_SCORES.spread, entry?.blockID, entry && b ? () => snippet(this.extraEntries.get(b.id) === entry ? blockExtraText(b) : contentText(this, b), entry.folded, sorted[0]!) : undefined);
        }
      }
    }
    approx = true; // ab hier: ungefähre Treffer
    // Ein Tippfehler bzw. Plural-s in Titelwörtern – nur für kurze Anfragen (ein, zwei Wörter, ohne Ziffern) und
    // solange die genauen Treffer die Liste nicht füllen (BSD-280: lange Anfragen sind Volltext, keine Titel).
    if (hits.size < limit && q.length >= 4 && terms.length <= 2 && !/\p{N}/u.test(q)) {
      for (const [id, words] of this.titleWords) {
        if (tick()) return undefined;
        if (hits.has(id)) continue;
        if (words.length && terms.every((t) => words.some((w) => w.startsWith(t) || nearWord(w, t) || (w.length > t.length && nearWord(w.slice(0, t.length + 1), t)))))
          add(id, EXTENDED_SCORES.fuzzyTitle);
      }
    }
    // Zusammengeschrieben getippt („syncarchitecture“): Titel ohne Leerzeichen.
    if (hits.size < limit && terms.length === 1 && q.length >= 8) {
      for (const [id, folded] of this.titles) {
        if (tick()) return undefined;
        if (!hits.has(id) && folded.includes(" ") && folded.replaceAll(" ", "").includes(q)) add(id, EXTENDED_SCORES.joinedTitle);
      }
    }
    // Tippfehler und andere Wortformen im ganzen Text: Jeder Begriff darf auch eines der Wörter aus dem Workspace
    // sein, die er gemeint haben könnte. Nur wenn die genauen Treffer die Liste nicht füllen; je weniger Abweichung,
    // desto weiter oben.
    // `skip`: ein Begriff, der fehlen darf (letzte Stufe: bei drei und mehr Begriffen passt einer vielleicht gar nicht).
    const fuzzyPass = (use: string[], penalty: number): true | undefined => {
      const needles = use.map((t) => ({ term: t, alts: this.alternatives(t) }));
      if (penalty === 0 && !needles.some((x) => x.alts.length > 0)) return true;
      const rare = (t: string) => (/\p{N}/u.test(t) ? 1000 : 0) + t.length;
      needles.sort((a, b) => rare(b.term) - rare(a.term));
      let cand: Map<string, number> | undefined; // Seite → Summe der Abweichungen
      const firstEntry = new Map<string, { entry: ContentEntry; word: string }>();
      for (const { term, alts } of needles) {
        const next = new Map<string, number>();
        const visit = (page: string, folded: string, entry?: ContentEntry) => {
          if (hits.has(page) || (cand && !cand.has(page))) return;
          let d: number | undefined, word = term;
          if (folded.includes(term)) d = 0;
          else for (const a of alts) if (folded.includes(a.word)) { d = a.distance; word = a.word; break; }
          if (d === undefined) return;
          const before = next.get(page);
          if (before === undefined || d < before) next.set(page, d);
          if (entry) {
            const best = firstEntry.get(page);
            if (!best || comparePaths(entry.path, best.entry.path) < 0) firstEntry.set(page, { entry, word });
          }
        };
        for (const [id, folded] of this.titles) { if (tick()) return undefined; visit(id, folded); }
        if (!titleOnly) {
          for (const map of [this.contentEntries, this.extraEntries]) {
            for (const e of map.values()) { if (tick()) return undefined; visit(e.page, e.folded, e); }
          }
          for (const [id, folded] of this.rows) { if (tick()) return undefined; visit(id, folded); }
          for (const [id, folded] of this.extraRows) { if (tick()) return undefined; visit(id, folded); }
        }
        if (cand) for (const [page, d] of next) next.set(page, d + (cand.get(page) ?? 0));
        cand = next;
        if (cand.size === 0) break;
      }
      for (const [page, d] of cand ?? []) {
        const first = firstEntry.get(page);
        const b = first ? blocks.get(first.entry.blockID) : undefined;
        add(page, Math.max(1, EXTENDED_SCORES.fuzzy - d - penalty), first?.entry.blockID,
          first && b ? () => snippet(this.extraEntries.get(b.id) === first.entry ? blockExtraText(b) : contentText(this, b), first.entry.folded, first.word) : undefined);
      }
      return true;
    };
    if (hits.size < limit && terms.length <= 8 && fuzzyPass(terms, 0) === undefined) return undefined;
    // Immer noch nichts: Bei drei und mehr Begriffen darf einer fehlen (ein Wort, das auf der Seite gar nicht steht).
    if (hits.size === 0 && terms.length >= 3 && terms.length <= 6) {
      for (let i = 0; i < terms.length; i++) {
        if (fuzzyPass(terms.filter((_, j) => j !== i), 3) === undefined) return undefined;
      }
    }
    return true;
  }

  /** Wie `run`, ohne Abbruch (Signatur wie Swift `SearchCorpus.search`). */
  search(query: string, filters: SearchFilters = {}, sort: SearchSort = "bestMatch", limit = 50, now = fromJSDate(new Date())): SearchHit[] {
    return this.run(query, { filters, sort, limit, now }) ?? [];
  }
}

/** Index über einen Store-Stand (Swift `SearchCorpus.build`); bleibt für bestehende Aufrufer erhalten. */
export class SearchCorpus extends SearchIndex {
  constructor(src: SearchSource) {
    super();
    this.load(src);
  }
}

// MARK: Anbindung an den Store

/** Vollständiger Stand für einen neuen Index (z. B. als erste Nachricht an den Worker). */
export function searchSnapshot(store: WorkspaceStore): SearchDelta {
  const upserts: WireRecord[] = [];
  for (const data of store.databases.values()) upserts.push({ kind: "database", data });
  for (const data of store.blocks.values()) upserts.push({ kind: "block", data });
  return { upserts, deletions: [] };
}

/** Die Änderung einer Store-Transaktion als Index-Delta (Blöcke und Datenbanken). */
export function searchDeltaFrom(store: WorkspaceStore, change: StoreChange): SearchDelta {
  const upserts: WireRecord[] = [];
  const deletions: RecordKeyString[] = [];
  for (const key of change.keys) {
    if (!key.startsWith("block:") && !key.startsWith("database:")) continue;
    // BSD-30: der Index braucht die Datenbank mit ihren Properties
    const r = store.logicalRecord(key);
    if (r) upserts.push(r);
    else deletions.push(key);
  }
  return { upserts, deletions };
}

/** Meldet jede Store-Änderung als Delta (für einen Worker: `send = (d) => worker.postMessage({type: "apply", delta: d})`). */
export function observeSearchDeltas(store: WorkspaceStore, send: (delta: SearchDelta) => void): () => void {
  return store.observe((change) => {
    const d = searchDeltaFrom(store, change);
    if (d.upserts.length > 0 || d.deletions.length > 0) send(d);
  });
}

/** Index im selben Thread, der dem Store folgt. `dispose()` meldet ab. */
export function attachSearchIndex(store: WorkspaceStore): { index: SearchIndex; dispose: () => void } {
  const index = SearchIndex.fromSource(store);
  const dispose = observeSearchDeltas(store, (d) => index.apply(d));
  return { index, dispose };
}

// MARK: Worker-Protokoll

export type SearchRequest =
  | { type: "load"; delta: SearchDelta }
  | { type: "apply"; delta: SearchDelta }
  | { type: "search"; id: number; query: string; filters?: SearchFilters; sort?: SearchSort; limit?: number; now?: number };

export type SearchResponse = { type: "result"; id: number; hits: SearchHit[]; revision: number };

/**
 * Eine Nachricht im Worker verarbeiten. `isCancelled` kann eine neuere Anfrage melden (z. B. über einen
 * SharedArrayBuffer-Zähler); dann gibt es keine Antwort.
 */
export function handleSearchMessage(index: SearchIndex, msg: SearchRequest, isCancelled?: () => boolean): SearchResponse | undefined {
  switch (msg.type) {
    case "load": {
      const fresh = SearchIndex.fromRecords(msg.delta.upserts);
      index.load(fresh);
      return undefined;
    }
    case "apply":
      index.apply(msg.delta);
      return undefined;
    case "search": {
      const opts: SearchOptions = {};
      if (msg.filters !== undefined) opts.filters = msg.filters;
      if (msg.sort !== undefined) opts.sort = msg.sort;
      if (msg.limit !== undefined) opts.limit = msg.limit;
      if (msg.now !== undefined) opts.now = msg.now;
      if (isCancelled !== undefined) opts.isCancelled = isCancelled;
      const hits = index.run(msg.query, opts);
      return hits === undefined ? undefined : { type: "result", id: msg.id, hits, revision: index.revision };
    }
  }
}
