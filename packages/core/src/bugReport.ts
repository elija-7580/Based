// BSD-319: „Problem melden“ – der Kern ohne DOM. Editor-Aufzeichnung als Ringpuffer (Tasten, Eingabe, IME, Einfügen,
// Auswahl, Editor-Transaktionen, Yjs-Updates), das Bündel mit Schutz der Inhalte, Layout-Prüfung und der Plan für die
// Wiedergabe als Test (apps/web/e2e/replay/). Was der Browser liefert (Ereignisse, Rahmen, Bildschirmfoto), reicht die
// Web-Shell herein (apps/web/src/shell/bugReport.ts).
//
// Datenschutz: Im Speicher liegt die Aufzeichnung roh (sie verlässt das Gerät nie von selbst). Erst beim Bündeln wird
// Text ersetzt – Länge, Wortgrenzen, Zeichenklassen und Formatierung bleiben, damit sich der Fehler nachstellen lässt.
// Echter Text nur auf ausdrücklichen Wunsch; Token und E-Mails werden auch dann geschwärzt.

import { redactSecrets, type DiagnosticsEntry } from "./diagnostics.js";
import type { HangReport } from "./hangs.js";

// MARK: Text ersetzen

/**
 * Ersetzt Text so, dass Länge (UTF-16), Wortgrenzen und Zeichenklassen bleiben: Großbuchstaben → X, andere Buchstaben
 * → x, Ziffern → 0. Leerraum, Satzzeichen, Symbole und Emoji bleiben (Markdown-Kürzel wie „# “ oder „- [ ]“ wirken so
 * auch bei der Wiedergabe).
 */
export function scrambleText(text: string): string {
  return text.replace(/\p{Lu}|\p{Lt}|\p{Ll}|\p{Lm}|\p{Lo}|\p{N}/gu, (c) => {
    const r = /\p{N}/u.test(c) ? "0" : /\p{Lu}|\p{Lt}/u.test(c) ? "X" : "x";
    return r.repeat(c.length);
  });
}

/**
 * Schlüssel, deren Zeichenkettenwerte Struktur sind (Knoten- und Markentypen, Block-IDs, Farben, Ausrichtung,
 * Sprache eines Codeblocks) und deshalb bleiben. Alles andere (Text, Links, Bildunterschriften, Dateinamen) wird ersetzt.
 */
export const STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "type", "stepType", "id", "level", "textColor", "backgroundColor", "textAlignment", "language", "listType", "variant",
  // Block-Records des Block-Editors (ADR 0016): Elternverweis, Sortierschlüssel, Stempel, Farben, Verweise auf Records
  "parent", "sk", "node", "color", "meetingSection", "databaseID", "viewIDs", "linkTarget", "syncSource", "teamspace",
  "tableColumnColors", "cellColors", "root", "block", "blocks", "editor",
]);

/** Tiefe Kopie, in der jede Zeichenkette außerhalb von STRUCTURAL_KEYS durch `map` läuft (ProseMirror-JSON, Schritte). */
export function mapStrings(value: unknown, map: (s: string) => string, keep: ReadonlySet<string> = STRUCTURAL_KEYS, key?: string): unknown {
  if (typeof value === "string") return key !== undefined && keep.has(key) ? value : map(value);
  // Listen erben den Schlüssel (`viewIDs: ["…"]` bleibt, `content: ["…"]` wird ersetzt).
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, map, keep, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, map, keep, k);
    return out;
  }
  return value;
}

export const scrambleDeep = (value: unknown) => mapStrings(value, scrambleText);

const KEEP_HTML_ATTRS = new Set(["class", "style", "data-content-type", "data-level", "data-text-alignment", "data-text-color", "data-background-color", "data-language"]);

/** HTML aus der Zwischenablage: Text und Attributwerte ersetzt (außer Klassen, Stil, Blocktyp), Tags bleiben. */
export function scrambleHTML(html: string): string {
  return html
    .replace(/(\s)([\w:-]+)=("([^"]*)"|'([^']*)')/g, (m, sp: string, name: string, _q: string, dq?: string, sq?: string) => {
      if (KEEP_HTML_ATTRS.has(name.toLowerCase())) return m;
      return `${sp}${name}="${scrambleText(dq ?? sq ?? "")}"`;
    })
    .replace(/>([^<]+)</g, (_m, text: string) => `>${scrambleText(text)}<`)
    .replace(/^([^<]+)/, (_m, text: string) => scrambleText(text))
    .replace(/>([^<]+)$/, (_m, text: string) => `>${scrambleText(text)}`);
}

// MARK: Aufzeichnung

export interface Mods { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean }
/**
 * Auswahl im Editor. Alter Editor: ProseMirror-Positionen, `type` text, node, all, cell. Block-Editor (ADR 0016):
 * `type` „text“ mit `block` und Offsets im Block (UTF-16, wie der Kern), „blocks“ mit `blocks` (Blockauswahl) oder
 * „none“ (kein Cursor). `path`: Stelle des Blocks im Baum (für die Wiedergabe, wenn die ID dort anders heißt).
 */
export interface SelectionInfo { type: string; anchor: number; head: number; block?: string; blocks?: string[]; path?: number[] }
/** Wert oder Funktion, die ihn erst beim Bündeln liefert (ProseMirror-Dokumente und Schritte sind unveränderlich). */
export type Lazy<T = unknown> = T | (() => T);

export type RecordedEvent =
  /** Zustand einer Dokument-Wurzel; ab hier lässt sich wiedergeben. */
  | { t: number; kind: "checkpoint"; root: string; doc: Lazy; sel: SelectionInfo }
  | { t: number; kind: "key"; root?: string; key: string; code?: string; mods: Mods; repeat?: boolean; composing?: boolean }
  /** `beforeinput` */
  | { t: number; kind: "input"; root?: string; inputType: string; data?: string }
  | { t: number; kind: "composition"; root?: string; phase: "start" | "update" | "end"; data?: string }
  | { t: number; kind: "paste"; root?: string; plain?: string; html?: string; files: number }
  | { t: number; kind: "select"; root: string; sel: SelectionInfo; cause: "pointer" | "key" | "program" }
  | { t: number; kind: "pointer"; phase: "down" | "up"; x: number; y: number; button: number; detail: number; target: string }
  /** Editor-Transaktion: Schritte (JSON), danach die Auswahl, `meta`: Herkunft (z. B. y-sync, paste, uiEvent). */
  | { t: number; kind: "tr"; root: string; steps: Lazy<unknown[]>; docChanged: boolean; sel: SelectionInfo; meta?: string[] }
  | { t: number; kind: "yjs"; root: string; bytes: number; origin: string; update?: Lazy<Uint8Array> }
  /**
   * Block-Editor (ADR 0016): eine gespeicherte Transaktion an Blöcken der Seite – Name des Befehls (lokal), Herkunft
   * und je Block der Record danach (`block` fehlt: gelöscht). Records im Store sind unveränderlich, also nur Verweise.
   */
  | { t: number; kind: "change"; root: string; name?: string; origin: string; changes: Lazy<readonly BlockChangeRecord[]> }
  | { t: number; kind: "focus"; target: string };

/** Ein Block nach einer Transaktion (Block-Editor). `block` fehlt, wenn er gelöscht wurde. */
export interface BlockChangeRecord { id: string; block?: unknown }

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RecordedInput = DistributiveOmit<RecordedEvent, "t">;

export const RECORDER_LIMIT = 500;
export const RECORDER_WINDOW_MS = 120_000;
export const CHECKPOINT_EVERY = 50;

export interface InputRecorderOptions {
  now?: () => number;
  /** Höchstens so viele Ereignisse (Standard 500). */
  limit?: number;
  /** Nur die letzten … ms (Standard 2 min). */
  windowMs?: number;
  /** Alle … Ereignisse einen Zwischenstand je offenem Editor anlegen (Standard 50). */
  checkpointEvery?: number;
  /** Liefert Zwischenstände aller offenen Editoren (billig: Verweise auf unveränderliche Dokumente). */
  checkpoints?: () => DistributiveOmit<Extract<RecordedEvent, { kind: "checkpoint" }>, "t">[];
}

const boundary = (e: RecordedInput) =>
  (e.kind === "key" && !e.composing) || e.kind === "paste" || e.kind === "select" || (e.kind === "pointer" && e.phase === "down");

/**
 * Ringpuffer der Editor-Aufzeichnung. Kostet beim Tippen nur ein `push` (keine Serialisierung); der Anfang des Puffers
 * ist immer ein Zwischenstand, damit die Wiedergabe einen Ausgangszustand hat.
 */
export class InputRecorder {
  private events: RecordedEvent[] = [];
  private since = 0;
  private enabled = true;
  private readonly now: () => number;

  constructor(private readonly o: InputRecorderOptions = {}) {
    this.now = o.now ?? Date.now;
  }

  get size() { return this.events.length; }
  get on() { return this.enabled; }
  set on(v: boolean) { this.enabled = v; if (!v) this.clear(); }

  record(e: RecordedInput) {
    if (!this.enabled) return;
    const t = this.now();
    // Zwischenstand nur an einer Grenze: vor dem Beginn einer Eingabe (Taste, Einfügen, Klick), nie zwischen einer
    // Taste und ihrem `beforeinput` oder mitten in einer IME-Eingabe. So enthält er alles davor und nichts danach.
    if (boundary(e) && this.since >= (this.o.checkpointEvery ?? CHECKPOINT_EVERY)) {
      this.since = 0;
      for (const c of this.o.checkpoints?.() ?? []) this.events.push({ ...c, t });
    }
    this.events.push({ ...e, t } as RecordedEvent);
    if (e.kind !== "checkpoint") this.since++;
    this.trim(t);
  }

  private trim(t: number) {
    const limit = this.o.limit ?? RECORDER_LIMIT, from = t - (this.o.windowMs ?? RECORDER_WINDOW_MS);
    const ev = this.events;
    let i = 0;
    while (i < ev.length && (ev.length - i > limit || ev[i]!.t < from)) i++;
    if (i === 0) return;
    // am nächsten Zwischenstand abschneiden (ohne einen: dort, wo die Grenze liegt – dann war kein Editor offen)
    let j = i;
    while (j < ev.length && ev[j]!.kind !== "checkpoint") j++;
    this.events = ev.slice(j < ev.length ? j : i);
  }

  /** Eingefroren für ein Bündel (flache Kopie; Lazy-Werte werden erst beim Bündeln aufgelöst). */
  snapshot(): RecordedEvent[] { return this.events.slice(); }

  clear() { this.events = []; this.since = 0; }
}

const resolve = <T>(v: Lazy<T>): T => (typeof v === "function" ? (v as () => T)() : v);

// MARK: Layout

export interface Rect { x: number; y: number; w: number; h: number }
export interface LayoutItem {
  kind: "block" | "floating" | "selection" | "handle" | "focus";
  /** Kurzbeschreibung ohne Inhalt (z. B. `paragraph #id`, `menu .bn-suggestion-menu`). */
  label: string;
  rect: Rect;
  z?: string;
  position?: string;
  /** Hat einen deckenden Hintergrund. */
  opaque?: boolean;
  /** Block ist markiert (Blockauswahl). */
  selected?: boolean;
}
export interface LayoutIssue { kind: "covers"; over: string; under: string; area: number }

const intersect = (a: Rect, b: Rect): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * Was eine deckende schwebende Fläche über der Auswahl, dem Fokus oder einem markierten Block liegen hat (die „weiße
 * Fläche über dem markierten Block“). Anteil = überdeckte Fläche / Fläche des Darunterliegenden.
 */
export function layoutIssues(items: readonly LayoutItem[]): LayoutIssue[] {
  const over = items.filter((i) => (i.kind === "floating" || i.kind === "handle") && i.opaque);
  const under = items.filter((i) => i.kind === "selection" || i.kind === "focus" || (i.kind === "block" && i.selected));
  const out: LayoutIssue[] = [];
  for (const o of over) {
    for (const u of under) {
      const a = intersect(o.rect, u.rect), area = u.rect.w * u.rect.h;
      if (a > 0 && area > 0) out.push({ kind: "covers", over: o.label, under: u.label, area: Math.round((a / area) * 100) / 100 });
    }
  }
  return out;
}

// MARK: Bündel

export const BUNDLE_FORMAT = "based-bug-report";
export const BUNDLE_VERSION = 1;

export interface BugEnv { width: number; height: number; dpr: number; zoom: number; theme: string; style?: string; route?: string }
export interface BugApp { version?: string; commit?: string; shell: string; platform?: string; userAgent?: string }
export interface BugState {
  /** Wurzel des fokussierten Editors (Seite). */
  root?: string;
  /** Dokument beim Melden: ProseMirror-JSON (alter Editor) bzw. Blockbaum `{ editor: "blocks", blocks }` (Block-Editor). */
  doc?: unknown;
  /** Blockbaum (Typen, Verschachtelung, Attribute). */
  blocks?: unknown;
  sel?: SelectionInfo;
  focus?: string;
  menus: string[];
}

export interface BugBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  id: string;
  createdAt: string;
  /** Der Satz von Elija: was gemacht, was passiert. */
  note: string;
  realText: boolean;
  /** Dateiname des Bildschirmfotos im Bündel-Ordner. */
  screenshot?: string;
  app: BugApp;
  env: BugEnv;
  state: BugState;
  layout: { items: LayoutItem[]; issues: LayoutIssue[] };
  recording: { events: unknown[] };
  log: DiagnosticsEntry[];
  /** BSD-418: Hänger dieser und früherer Sitzungen (fehlt in älteren Bündeln). */
  hangs?: HangReport;
}

export interface BugBundleInput {
  id: string;
  now: number;
  note: string;
  realText: boolean;
  screenshot?: string;
  app: BugApp;
  env: BugEnv;
  state: BugState;
  layout: LayoutItem[];
  events: readonly RecordedEvent[];
  log: readonly DiagnosticsEntry[];
  hangs?: HangReport;
}

/** Bündel-ID aus der Zeit, sortierbar und als Ordnername tauglich: `20261111-170512-ab3f`. */
export function bundleID(now: number, rand: () => number = Math.random): string {
  const d = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${d}-${Math.floor(rand() * 0x10000).toString(16).padStart(4, "0")}`;
}

const isPrintable = (key: string) => [...key].length === 1;
const shortcut = (m: Mods) => m.meta === true || m.ctrl === true || m.alt === true;

const toBase64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
};

/** Ein Ereignis für das Bündel: Lazy aufgelöst, Text ersetzt (oder nur Geheimnisse geschwärzt). */
export function exportEvent(e: RecordedEvent, realText: boolean): Record<string, unknown> {
  const text = realText ? redactSecrets : scrambleText;
  const deep = (v: unknown) => mapStrings(v, text);
  switch (e.kind) {
    case "checkpoint": return { ...e, doc: deep(resolve(e.doc)) };
    case "tr": return { ...e, steps: deep(resolve(e.steps)) };
    case "change": return { ...e, changes: deep(resolve(e.changes)) };
    case "yjs": {
      const { update, ...rest } = e;
      return realText && update !== undefined ? { ...rest, update: toBase64(resolve(update)) } : rest;
    }
    case "key": {
      // Tasten, die Text tippen, verraten ihn: ersetzt und ohne physischen Code. Kürzel (⌘B) bleiben.
      if (realText || shortcut(e.mods) || !isPrintable(e.key)) return { ...e };
      const { code: _code, ...rest } = e;
      return { ...rest, key: scrambleText(e.key) };
    }
    case "input":
    case "composition": return e.data === undefined ? { ...e } : { ...e, data: text(e.data) };
    case "paste": return { ...e, ...(e.plain !== undefined ? { plain: text(e.plain) } : {}), ...(e.html !== undefined ? { html: realText ? redactSecrets(e.html) : scrambleHTML(e.html) } : {}) };
    default: return { ...e };
  }
}

/** Baut das Bündel. Standard: kein Nutzertext (ersetzt), keine Token; Log ist schon geschwärzt. */
export function buildBugBundle(i: BugBundleInput): BugBundle {
  const text = i.realText ? redactSecrets : scrambleText;
  const deep = (v: unknown) => (v === undefined ? undefined : mapStrings(v, text));
  const state: BugState = { menus: i.state.menus };
  if (i.state.root !== undefined) state.root = i.state.root;
  if (i.state.doc !== undefined) state.doc = deep(i.state.doc);
  if (i.state.blocks !== undefined) state.blocks = deep(i.state.blocks);
  if (i.state.sel) state.sel = i.state.sel;
  if (i.state.focus !== undefined) state.focus = i.state.focus;
  const events: unknown[] = [];
  for (const e of i.events) {
    try {
      events.push(exportEvent(e, i.realText));
    } catch { /* ein kaputtes Ereignis verhindert das Bündel nicht */ }
  }
  return {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, id: i.id, createdAt: new Date(i.now).toISOString(),
    note: redactSecrets(i.note.trim()), realText: i.realText,
    ...(i.screenshot ? { screenshot: i.screenshot } : {}),
    app: i.app, env: i.env, state,
    layout: { items: [...i.layout], issues: layoutIssues(i.layout) },
    recording: { events },
    log: i.log.map((e) => ({ ...e })),
    ...(i.hangs ? { hangs: i.hangs } : {}),
  };
}

/** Kurzfassung für Listen (Einstellungen, CLI). */
export interface BugBundleSummary { id: string; createdAt: string; note: string; events: number; issues: number; screenshot: boolean; realText: boolean }
export function summarizeBundle(b: BugBundle): BugBundleSummary {
  return { id: b.id, createdAt: b.createdAt, note: b.note, events: b.recording.events.length, issues: b.layout.issues.length, screenshot: !!b.screenshot, realText: b.realText };
}

/** Prüft ein geladenes JSON auf das Bündel-Format. */
export function parseBugBundle(json: unknown): BugBundle | undefined {
  const b = json as Partial<BugBundle> | null;
  if (!b || typeof b !== "object" || b.format !== BUNDLE_FORMAT || typeof b.id !== "string" || !b.recording || !Array.isArray(b.recording.events)) return undefined;
  return b as BugBundle;
}

// MARK: Wiedergabe

export type ReplayAction =
  /** Taste mit Modifikatoren im Playwright-Format (`ControlOrMeta+Shift+ArrowUp`). */
  | { kind: "press"; combo: string }
  /** Getippter Text (Taste für Taste). */
  | { kind: "type"; text: string }
  /** Text ohne Tasten (IME, Diktat, Emoji-Auswahl). */
  | { kind: "insertText"; text: string }
  | { kind: "select"; sel: SelectionInfo }
  | { kind: "paste"; plain?: string; html?: string }
  /** Nur im Modus „steps“: Editor-Schritte (alter Editor) bzw. Block-Records (Block-Editor) direkt anwenden. */
  | { kind: "steps"; steps: unknown[] };

export interface ReplayPlan {
  root: string;
  start: { doc: unknown; sel: SelectionInfo };
  actions: ReplayAction[];
  /** Endzustand beim Melden (zum Vergleich). */
  expected?: unknown;
}

const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt", "AltGraph", "CapsLock", "Fn", "OS"]);
const SKIP_KEYS = new Set(["Process", "Dead", "Unidentified"]);

/** Playwright-Kürzel: ⌘ und Strg werden zu `ControlOrMeta` (Bündel vom Mac laufen so auch unter Linux). */
export function comboFor(key: string, mods: Mods): string {
  const parts: string[] = [];
  if (mods.meta || mods.ctrl) parts.push("ControlOrMeta");
  if (mods.alt) parts.push("Alt");
  if (mods.shift) parts.push("Shift");
  const name = key === " " ? "Space" : key.length === 1 && (mods.meta || mods.ctrl || mods.alt) ? key.toLowerCase() : key;
  parts.push(name);
  return parts.join("+");
}

type Ev = Record<string, unknown> & { kind: string; root?: string };

/**
 * Plan für die Wiedergabe ab dem ersten Zwischenstand der Wurzel: Modus „input“ spielt Tasten, Eingaben, Einfügen und
 * Mausauswahl nach (findet Fehler in der Eingabeverarbeitung), Modus „steps“ wendet die aufgezeichneten Schritte an.
 * Block-Editor im Modus „input“: Transaktionen, die ein Klick ausgelöst hat (Klick unter die Seite, Menüpunkt, Griff)
 * oder die von anderen kamen (Echtzeit, Sync), werden als Records angewandt – Klicks selbst spielt die Wiedergabe nicht.
 */
export function replayPlan(bundle: BugBundle, opts: { root?: string; mode?: "input" | "steps" } = {}): ReplayPlan {
  const events = bundle.recording.events as Ev[];
  const root = opts.root ?? bundle.state.root ?? (events.find((e) => e.kind === "checkpoint")?.root);
  if (!root) throw new Error("The report has no editor to replay");
  const startAt = events.findIndex((e) => e.kind === "checkpoint" && e.root === root);
  if (startAt < 0) throw new Error("The recording has no starting point for this page");
  const start = events[startAt]!;
  const actions: ReplayAction[] = [];
  const push = (a: ReplayAction) => {
    const last = actions.at(-1);
    if (a.kind === "type" && last?.kind === "type") last.text += a.text;
    else actions.push(a);
  };
  const mine = (e: Ev) => e.root === undefined || e.root === root;
  let pendingKeyInput = false;
  /** Woher die nächste Transaktion kommt: Klick oder Eingabe (Tasten, Einfügen, IME). */
  let source: "pointer" | "input" | undefined;
  for (const e of events.slice(startAt + 1)) {
    if (opts.mode === "steps") {
      if (e.kind === "tr" && e.root === root && e.docChanged) actions.push({ kind: "steps", steps: e.steps as unknown[] });
      else if (e.kind === "change" && e.root === root && Array.isArray(e.changes) && e.changes.length) actions.push({ kind: "steps", steps: e.changes as unknown[] });
      continue;
    }
    if (e.kind === "pointer") {
      if (e.phase === "down") source = "pointer";
      continue;
    }
    if (!mine(e)) continue;
    if (e.kind === "key" || e.kind === "input" || e.kind === "paste" || e.kind === "composition") source = "input";
    switch (e.kind) {
      case "change": {
        const own = e.origin === "local" || e.origin === "undo" || e.origin === "redo";
        if (e.root === root && Array.isArray(e.changes) && e.changes.length && (!own || source === "pointer")) actions.push({ kind: "steps", steps: e.changes as unknown[] });
        break;
      }
      case "key": {
        const key = String(e.key), mods = (e.mods ?? {}) as Mods;
        pendingKeyInput = false;
        if (e.composing || SKIP_KEYS.has(key) || MODIFIER_KEYS.has(key)) break;
        if (!shortcut(mods) && isPrintable(key)) {
          push({ kind: "type", text: key });
          pendingKeyInput = true;
          break;
        }
        // ⌘V: das folgende `paste` bringt den Inhalt mit; ein echtes ⌘V fände eine leere Zwischenablage.
        if ((mods.meta || mods.ctrl) && key.toLowerCase() === "v") break;
        push({ kind: "press", combo: comboFor(key, mods) });
        break;
      }
      case "input": {
        const type = String(e.inputType), data = typeof e.data === "string" ? e.data : undefined;
        if (pendingKeyInput) { pendingKeyInput = false; break; }
        if ((type === "insertText" || type === "insertReplacementText") && data) push({ kind: "insertText", text: data });
        break;
      }
      case "composition":
        if (e.phase === "end" && typeof e.data === "string" && e.data) push({ kind: "insertText", text: e.data });
        break;
      case "paste":
        actions.push({ kind: "paste", ...(typeof e.plain === "string" ? { plain: e.plain } : {}), ...(typeof e.html === "string" ? { html: e.html } : {}) });
        break;
      case "select":
        if (e.cause === "pointer" && e.root === root) actions.push({ kind: "select", sel: e.sel as SelectionInfo });
        break;
      default: break;
    }
  }
  return { root, start: { doc: start.doc, sel: start.sel as SelectionInfo }, actions, ...(bundle.state.doc !== undefined && bundle.state.root === root ? { expected: bundle.state.doc } : {}) };
}

/** Dokument zum Vergleichen: ohne Block-IDs und Sortierschlüssel (die Wiedergabe-Seite vergibt eigene IDs). */
export function normalizeDoc(doc: unknown): unknown {
  if (Array.isArray(doc)) return doc.map(normalizeDoc);
  if (doc && typeof doc === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) if (k !== "id" && k !== "sk") out[k] = normalizeDoc(v);
    return out;
  }
  return doc;
}
