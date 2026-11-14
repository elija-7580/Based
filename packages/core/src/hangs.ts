// BSD-418: Hänger-Analyse wie in der Swift-App (legacy/App/Shared/Diagnostics/HangWatchdog.swift) – rein, ohne DOM.
// Die Hülle (apps/web/src/shell/hangs.ts) misst; hier liegen Datensatz, Ringpuffer, Breadcrumbs, Statistik, Zuordnung
// von Ursachen (Long Animation Frames), das Persistenz-Format und der Watchdog für laufende Hänger (Worker).
// Nie Nutzerinhalte: Breadcrumbs und Ursachen sind feste Namen und laufen durch redact().
import { redact } from "./diagnostics.js";

export type HangSource = "main" | "worker" | "input";

export interface HangRecord {
  /** Beginn (Epoche, ms). */
  at: number;
  /** Dauer der Blockade (ms). */
  ms: number;
  /** Was gerade lief (Startphase oder Ansicht, z. B. „route page“). */
  activity: string;
  /** Die letzten Schritte davor (feste Namen, älteste zuerst). */
  breadcrumbs: string[];
  /** Was blockierte: Skript/Funktion (Long Animation Frame), Eingabe oder Store-Operation. */
  culprit?: string;
  source: HangSource;
  /** Lief noch, als die Sitzung endete (vom Watchdog-Worker gemeldet). */
  ongoing?: boolean;
}

/** Ab wann etwas ein Hänger ist (ms). Eingaben ab 200 ms (INP „needs improvement“), Store-Anfragen ab 1 s. */
export const HANG_THRESHOLDS: Readonly<Record<HangSource, number>> = { main: 250, input: 200, worker: 1000 };
/** Ab hier zählt ein Hänger als „Freeze“ (Sitzungs-Marke, Absturzbericht – wie bisher 2 s). */
export const FREEZE_MS = 2000;
/** So viele Hänger behält eine Sitzung im Speicher (wie Swift). */
export const HANG_LIMIT = 200;
export const BREADCRUMB_LIMIT = 20;
/** So viele Breadcrumbs stehen in einem Hänger. */
export const HANG_CRUMBS = 10;

const NAME_LIMIT = 60;

/**
 * Ein Name für Breadcrumbs, Aktivität oder Ursache: geschwärzt (redact), ohne Zeilenumbrüche, kurz. Nur feste Namen
 * übergeben (Route, Befehl, data-testid, Rolle) – nie Text, Titel oder Inhalte.
 */
export function hangName(name: string, limit = NAME_LIMIT): string {
  const m = redact(String(name)).replace(/\s+/g, " ").trim();
  return m.length > limit ? m.slice(0, limit - 1) + "…" : m;
}

// MARK: Breadcrumbs

interface Crumb { name: string; at: number; count: number }

/** Die letzten Schritte (Route, Befehl, Klickziel). Gleiche Schritte hintereinander werden zu „name ×n“. */
export class BreadcrumbTrail {
  private crumbs: Crumb[] = [];
  private listeners = new Set<() => void>();
  constructor(private readonly limit = BREADCRUMB_LIMIT, private readonly now: () => number = Date.now) {}

  add(name: string) {
    const n = hangName(name);
    if (!n) return;
    const last = this.crumbs[this.crumbs.length - 1];
    if (last && last.name === n) {
      last.count += 1;
      last.at = this.now();
    } else {
      this.crumbs.push({ name: n, at: this.now(), count: 1 });
      if (this.crumbs.length > this.limit) this.crumbs.splice(0, this.crumbs.length - this.limit);
    }
    for (const l of this.listeners) l();
  }

  /** Älteste zuerst, höchstens `n`. */
  list(n = this.limit): string[] {
    return this.crumbs.slice(-n).map((c) => (c.count > 1 ? `${c.name} ×${c.count}` : c.name));
  }

  /** Wird nach jedem Schritt gerufen (z. B. um den Watchdog-Worker auf Stand zu halten). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
}

// MARK: Statistik

export interface HangStats {
  /** Alle Hänger (Hauptthread, Eingaben, Store). */
  count: number;
  main: number;
  input: number;
  worker: number;
  /** Summe der blockierten Zeit (Hauptthread und Eingaben – das, was man merkt). */
  blockedMs: number;
  p50: number;
  p95: number;
  max: number;
  /** Hänger ab 2 s (Hauptthread). */
  freezes: number;
}

const percentile = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : 0);

/** Kennzahlen; Perzentile und Maximum über die spürbaren Hänger (Hauptthread und Eingaben). */
export function hangStats(hangs: readonly HangRecord[]): HangStats {
  const felt = hangs.filter((h) => h.source !== "worker").map((h) => h.ms).sort((a, b) => a - b);
  return {
    count: hangs.length,
    main: hangs.filter((h) => h.source === "main").length,
    input: hangs.filter((h) => h.source === "input").length,
    worker: hangs.filter((h) => h.source === "worker").length,
    blockedMs: Math.round(felt.reduce((s, ms) => s + ms, 0)),
    p50: Math.round(percentile(felt, 50)),
    p95: Math.round(percentile(felt, 95)),
    max: Math.round(felt[felt.length - 1] ?? 0),
    freezes: hangs.filter((h) => h.source === "main" && h.ms >= FREEZE_MS).length,
  };
}

/** „820 ms“, „3.4 s“. */
export function formatHangMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

// MARK: Monitor

export interface HangInput {
  ms: number;
  source: HangSource;
  /** Beginn auf der monotonen Uhr (performance.now) – für die Zuordnung von Frames und Eingaben. */
  start?: number;
  culprit?: string;
  ongoing?: boolean;
  /** Beginn (Epoche); Standard: jetzt minus Dauer. */
  at?: number;
}

/** Ein langer Frame (Long Animation Frame oder Long Task) auf der monotonen Uhr. */
export interface FrameInfo { start: number; duration: number; culprit?: string }

export interface HangMonitorOptions {
  thresholds?: Partial<Record<HangSource, number>>;
  limit?: number;
  /** Uhr (Epoche). */
  now?: () => number;
  activity?: () => string;
  crumbs?: BreadcrumbTrail;
  /** Ursache, wenn der Browser keine nennt (WebKit: „no attribution (WebKit)“). */
  noAttribution?: string;
  initial?: readonly HangRecord[];
}

interface Range { start: number; end: number; rec: HangRecord }

const overlaps = (a0: number, a1: number, b0: number, b1: number, slack = 0) => a0 <= b1 + slack && b0 <= a1 + slack;

/**
 * Sammelt Hänger einer Sitzung: Ringpuffer (200), Schwellen je Quelle, Breadcrumbs und Aktivität im Moment des Hängers.
 * Lange Frames ergänzen einen Hauptthread-Hänger um die Ursache (und die genauere Dauer); eine langsame Eingabe, die in
 * einen Hauptthread-Hänger fällt, zählt nicht doppelt.
 */
export class HangMonitor {
  private hangs: HangRecord[];
  private ranges: Range[] = [];
  private frames: FrameInfo[] = [];
  private listeners = new Set<() => void>();
  private snap: readonly HangRecord[];
  readonly thresholds: Record<HangSource, number>;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly activity: () => string;
  readonly crumbs: BreadcrumbTrail;
  private readonly noAttribution: string | undefined;

  constructor(o: HangMonitorOptions = {}) {
    this.thresholds = { ...HANG_THRESHOLDS, ...o.thresholds };
    this.limit = o.limit ?? HANG_LIMIT;
    this.now = o.now ?? Date.now;
    this.activity = o.activity ?? (() => "");
    this.crumbs = o.crumbs ?? new BreadcrumbTrail(BREADCRUMB_LIMIT, this.now);
    this.noAttribution = o.noAttribution;
    this.hangs = (o.initial ?? []).slice(-this.limit);
    this.snap = this.hangs;
  }

  get all(): readonly HangRecord[] { return this.snap; }
  stats(): HangStats { return hangStats(this.hangs); }

  /** Einen Hänger eintragen (unter der Schwelle seiner Quelle: nichts). */
  record(i: HangInput): HangRecord | undefined {
    if (!(i.ms >= this.thresholds[i.source])) return undefined;
    const rec: HangRecord = {
      at: Math.round(i.at ?? this.now() - i.ms), ms: Math.round(i.ms), activity: hangName(this.activity(), 80), breadcrumbs: this.crumbs.list(HANG_CRUMBS), source: i.source,
      ...(i.culprit ? { culprit: hangName(i.culprit, 160) } : {}), ...(i.ongoing ? { ongoing: true } : {}),
    };
    if (i.source === "main" && i.start !== undefined) {
      const range = { start: i.start, end: i.start + i.ms, rec };
      this.ranges.push(range);
      if (this.ranges.length > 50) this.ranges.shift();
      // Ein Frame, der schon da ist (Beobachter kam vor dem Zeitgeber), liefert die Ursache.
      for (const f of this.frames) this.attach(range, f);
      if (!rec.culprit && this.noAttribution) rec.culprit = this.noAttribution;
    }
    this.hangs.push(rec);
    if (this.hangs.length > this.limit) this.hangs.splice(0, this.hangs.length - this.limit);
    this.changed();
    return rec;
  }

  /** Langer Frame: Ursache und genauere Dauer an den passenden Hauptthread-Hänger hängen (oder für später merken). */
  noteFrame(f: FrameInfo) {
    this.frames.push(f);
    if (this.frames.length > 30) this.frames.shift();
    let hit = false;
    for (const r of this.ranges) hit = this.attach(r, f) || hit;
    if (hit) this.changed();
  }

  private attach(r: Range, f: FrameInfo): boolean {
    if (!overlaps(r.start, r.end, f.start, f.start + f.duration)) return false;
    let changed = false;
    if (f.culprit && (!r.rec.culprit || r.rec.culprit === this.noAttribution)) { r.rec.culprit = hangName(f.culprit, 160); changed = true; }
    // Der Zeitgeber sieht die Blockade erst, wenn er dran ist (bis zu einem Takt zu kurz); der Frame misst genau.
    if (f.duration > r.rec.ms && f.duration < r.rec.ms * 2 + 200) {
      r.rec.ms = Math.round(f.duration);
      r.end = r.start + f.duration;
      changed = true;
    }
    return changed;
  }

  /** Langsame Eingabe (Event Timing). Fällt sie in einen Hauptthread-Hänger, steht sie dort schon. */
  noteInput(e: { start: number; duration: number; name: string }): HangRecord | undefined {
    if (this.ranges.some((r) => overlaps(r.start, r.end, e.start, e.start + e.duration, 16))) return undefined;
    return this.record({ ms: e.duration, source: "input", start: e.start, culprit: e.name });
  }

  /** Wie lange der Hauptthread zwischen t0 und t1 (monoton) blockiert war – damit eine verspätete Store-Antwort nicht dem Worker angelastet wird. */
  blockedBetween(t0: number, t1: number): number {
    let sum = 0;
    for (const r of this.ranges) sum += Math.max(0, Math.min(t1, r.end) - Math.max(t0, r.start));
    return sum;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = (): readonly HangRecord[] => this.snap;

  private changed() {
    this.snap = [...this.hangs];
    for (const l of this.listeners) l();
  }
}

// MARK: Ursache aus Long Animation Frames

/** Ein Skript-Eintrag eines Long Animation Frames (Chromium; WebKit kennt sie nicht). */
export interface LoAFScript { invoker?: string; invokerType?: string; sourceURL?: string; sourceFunctionName?: string; sourceCharPosition?: number; duration?: number }

const fileOf = (url: string) => {
  const clean = url.split(/[?#]/)[0] ?? "";
  return clean.slice(clean.lastIndexOf("/") + 1);
};

/** „busyLoop (hangs.ts:120) · TimerHandler:setTimeout“ – das längste Skript des Frames, ohne Abfrageteile der URL. */
export function loafCulprit(scripts: readonly LoAFScript[] | undefined): string | undefined {
  if (!scripts?.length) return undefined;
  const s = [...scripts].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0]!;
  const fn = s.sourceFunctionName || "anonymous";
  const file = s.sourceURL ? fileOf(s.sourceURL) : "";
  const where = file ? ` (${file}${typeof s.sourceCharPosition === "number" && s.sourceCharPosition >= 0 ? `:${s.sourceCharPosition}` : ""})` : "";
  const via = s.invoker ? ` · ${s.invokerType ? `${s.invokerType}:` : ""}${s.invoker}` : "";
  return hangName(`${fn}${where}${via}`, 160);
}

// MARK: Persistenz (localStorage der Hülle)

export const HANG_STORE_KEY = "based.diagnostics.hangs";
export const HANG_STORE_VERSION = 1;
/** So viele Sitzungen und Hänger je Sitzung bleiben gespeichert. */
export const HANG_STORE_SESSIONS = 4;
export const HANG_STORE_PER_SESSION = 50;

export interface HangSessionData {
  id: string;
  startedAt: number;
  /** Kennzahlen über alle Hänger der Sitzung (auch die, die nicht mehr in `hangs` stehen). */
  stats: HangStats;
  /** Die neuesten Hänger (höchstens 50). */
  hangs: HangRecord[];
}

export interface HangStoreData { v: typeof HANG_STORE_VERSION; sessions: HangSessionData[] }

const SOURCES = new Set<HangSource>(["main", "worker", "input"]);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Einen gespeicherten Hänger lesen; fehlende Felder werden ergänzt (ältere Einträge kannten `source` nicht = Hauptthread). */
export function parseHangRecord(v: unknown): HangRecord | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const at = num(o.at), ms = num(o.ms);
  if (at === undefined || ms === undefined) return undefined;
  const source = SOURCES.has(o.source as HangSource) ? (o.source as HangSource) : "main";
  return {
    at, ms, source,
    activity: typeof o.activity === "string" ? hangName(o.activity, 80) : "",
    breadcrumbs: Array.isArray(o.breadcrumbs) ? o.breadcrumbs.filter((c): c is string => typeof c === "string").slice(-BREADCRUMB_LIMIT).map((c) => hangName(c)) : [],
    ...(typeof o.culprit === "string" && o.culprit ? { culprit: hangName(o.culprit, 160) } : {}),
    ...(o.ongoing === true ? { ongoing: true } : {}),
  };
}

/**
 * Gespeicherte Hänger lesen. Fehlt der Eintrag, ist er kaputt oder von einer unbekannten (neueren) Version: leer.
 * Format 0 (vor dem Versionsfeld: nur eine Liste von Hängern) wird als eine Sitzung gelesen.
 */
export function parseHangStore(raw: string | null | undefined): HangStoreData {
  const empty: HangStoreData = { v: HANG_STORE_VERSION, sessions: [] };
  if (!raw) return empty;
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return empty; }
  if (Array.isArray(json)) {
    const hangs = json.map(parseHangRecord).filter((h): h is HangRecord => !!h).slice(-HANG_STORE_PER_SESSION);
    return hangs.length ? { v: HANG_STORE_VERSION, sessions: [{ id: "legacy", startedAt: hangs[0]!.at, stats: hangStats(hangs), hangs }] } : empty;
  }
  const o = json as { v?: unknown; sessions?: unknown } | null;
  if (!o || typeof o !== "object" || o.v !== HANG_STORE_VERSION || !Array.isArray(o.sessions)) return empty;
  const sessions: HangSessionData[] = [];
  for (const s of o.sessions as unknown[]) {
    const so = s as Partial<HangSessionData> | null;
    if (!so || typeof so.id !== "string" || num(so.startedAt) === undefined) continue;
    const hangs = (Array.isArray(so.hangs) ? so.hangs : []).map(parseHangRecord).filter((h): h is HangRecord => !!h).slice(-HANG_STORE_PER_SESSION);
    const st = so.stats as Partial<HangStats> | undefined;
    const stats = st && typeof st === "object" && num(st.count) !== undefined ? { ...hangStats(hangs), ...pickStats(st) } : hangStats(hangs);
    sessions.push({ id: so.id, startedAt: so.startedAt!, stats, hangs });
  }
  return { v: HANG_STORE_VERSION, sessions: sessions.slice(-HANG_STORE_SESSIONS) };
}

function pickStats(st: Partial<HangStats>): Partial<HangStats> {
  const out: Partial<HangStats> = {};
  for (const k of ["count", "main", "input", "worker", "blockedMs", "p50", "p95", "max", "freezes"] as const) {
    const v = num(st[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Die Sitzung im Speicher aktualisieren (neu oder ersetzt), ältere Sitzungen fallen heraus. */
export function storeSession(data: HangStoreData, session: { id: string; startedAt: number; hangs: readonly HangRecord[] }): HangStoreData {
  const entry: HangSessionData = { id: session.id, startedAt: session.startedAt, stats: hangStats(session.hangs), hangs: session.hangs.slice(-HANG_STORE_PER_SESSION).map((h) => ({ ...h, breadcrumbs: [...h.breadcrumbs] })) };
  const others = data.sessions.filter((s) => s.id !== session.id);
  return { v: HANG_STORE_VERSION, sessions: [...others, entry].slice(-HANG_STORE_SESSIONS) };
}

/** Einen Hänger an eine (frühere) Sitzung anhängen – z. B. den laufenden Hänger, mit dem sie endete. */
export function appendToSession(data: HangStoreData, sessionID: string, hang: HangRecord, startedAt = hang.at): HangStoreData {
  const cur = data.sessions.find((s) => s.id === sessionID);
  const hangs = [...(cur?.hangs ?? []), hang].slice(-HANG_STORE_PER_SESSION);
  const prevStats = cur?.stats;
  const added = hangStats([hang]);
  const stats: HangStats = prevStats
    ? { ...prevStats, count: prevStats.count + 1, main: prevStats.main + added.main, input: prevStats.input + added.input, worker: prevStats.worker + added.worker,
        blockedMs: prevStats.blockedMs + added.blockedMs, max: Math.max(prevStats.max, added.max), freezes: prevStats.freezes + added.freezes, p95: Math.max(prevStats.p95, hangStats(hangs).p95) }
    : hangStats(hangs);
  const entry: HangSessionData = { id: sessionID, startedAt: cur?.startedAt ?? startedAt, stats, hangs };
  return { v: HANG_STORE_VERSION, sessions: [...data.sessions.filter((s) => s.id !== sessionID), entry].sort((a, b) => a.startedAt - b.startedAt).slice(-HANG_STORE_SESSIONS) };
}

// MARK: Laufender Hänger (Marker des Watchdog-Workers)

export const HANG_MARKER_VERSION = 1;

/** Vom Watchdog-Worker geschrieben, solange der Hauptthread > 2 s nicht antwortet (IndexedDB). */
export interface HangMarker {
  v: typeof HANG_MARKER_VERSION;
  /** Sitzung (Tab) des hängenden Hauptthreads. */
  session: string;
  /** Beginn (Epoche). */
  startedAt: number;
  /** Bisher gemessene Dauer (ms). */
  ms: number;
  /** Letzte Aktualisierung (Epoche) – ein frischer Marker gehört zu einem Tab, der gerade noch hängt. */
  updatedAt: number;
  activity: string;
  breadcrumbs: string[];
}

export function parseHangMarker(v: unknown): HangMarker | undefined {
  const o = v as Partial<HangMarker> | null;
  if (!o || typeof o !== "object" || o.v !== HANG_MARKER_VERSION || typeof o.session !== "string") return undefined;
  const startedAt = num(o.startedAt), ms = num(o.ms);
  if (startedAt === undefined || ms === undefined) return undefined;
  return {
    v: HANG_MARKER_VERSION, session: o.session, startedAt, ms, updatedAt: num(o.updatedAt) ?? startedAt + ms,
    activity: typeof o.activity === "string" ? hangName(o.activity, 80) : "",
    breadcrumbs: Array.isArray(o.breadcrumbs) ? o.breadcrumbs.filter((c): c is string => typeof c === "string").slice(-HANG_CRUMBS).map((c) => hangName(c)) : [],
  };
}

/** Der Hänger, mit dem eine Sitzung endete, als Datensatz. */
export function markerHang(m: HangMarker): HangRecord {
  return { at: m.startedAt, ms: Math.round(m.ms), activity: m.activity, breadcrumbs: m.breadcrumbs, source: "main", ongoing: true };
}

/** Ein Satz für Hinweis, Log und Bericht. */
export function ongoingHangNotice(m: Pick<HangMarker, "ms" | "activity">): string {
  const secs = Math.max(2, Math.floor(m.ms / 1000));
  return `Based hung for more than ${secs} s${m.activity ? ` during ${m.activity}` : ""} and was then closed or reloaded.`;
}

/**
 * Marker beendeter Sitzungen: die vorige Sitzung dieses Tabs (Neuladen mitten im Hänger) oder Marker, die nicht mehr
 * aktualisiert werden. Ein frischer Marker einer anderen Sitzung gehört einem anderen Tab, der gerade hängt.
 */
export function deadMarkers(markers: readonly HangMarker[], o: { mine: string; previous?: string | undefined; now: number; freshMs?: number }): HangMarker[] {
  const fresh = o.freshMs ?? 4000;
  return markers.filter((m) => m.session !== o.mine && (m.session === o.previous || o.now - m.updatedAt > fresh));
}

// MARK: Watchdog (läuft im Worker)

export type WatchdogMessage =
  | { type: "start"; session: string }
  | { type: "pong"; id: number }
  | { type: "context"; activity: string; breadcrumbs: string[] }
  | { type: "pause" }
  | { type: "resume" };
export type WatchdogEvent = { type: "ping"; id: number } | { type: "recovered"; ms: number };

export interface WatchdogOptions {
  /** Monotone Uhr des Workers. */
  now: () => number;
  /** Epoche. */
  epoch: () => number;
  send: (e: WatchdogEvent) => void;
  writeMarker: (m: HangMarker) => void;
  clearMarker: (session: string) => void;
  /** Ab hier gilt ein Hänger als „läuft noch“ und wird sofort festgehalten (ms). */
  ongoingAfterMs?: number;
  /** Abstand der Marker-Aktualisierungen (ms). */
  updateEveryMs?: number;
}

/**
 * Gegenstück zum Swift-Watchdog-Thread: der Worker pingt den Hauptthread; antwortet er länger als 2 s nicht, schreibt
 * der Worker einen Marker (Beginn, Aktivität, Breadcrumbs) und aktualisiert ihn jede Sekunde. Antwortet der Hauptthread,
 * wird der Marker gelöscht. Überlebt der Marker (Tab beendet, neu geladen, App hart beendet), zeigt der nächste Start, wo
 * es hing. `tick()` ruft der Worker in seinem Takt.
 */
export class HangWatchdog {
  private session = "";
  private pingID = 0;
  private sentAt: number | undefined;
  private sentEpoch = 0;
  private marked = false;
  private lastWrite = 0;
  private paused = true;
  private activity = "";
  private breadcrumbs: string[] = [];
  private readonly ongoingAfter: number;
  private readonly updateEvery: number;

  constructor(private readonly o: WatchdogOptions) {
    this.ongoingAfter = o.ongoingAfterMs ?? FREEZE_MS;
    this.updateEvery = o.updateEveryMs ?? 1000;
  }

  get waiting(): boolean { return this.sentAt !== undefined; }
  get ongoing(): boolean { return this.marked; }

  handle(m: WatchdogMessage) {
    switch (m.type) {
      case "start": this.session = m.session; this.paused = false; return;
      case "context": this.activity = hangName(m.activity, 80); this.breadcrumbs = m.breadcrumbs.slice(-HANG_CRUMBS).map((c) => hangName(c)); return;
      case "pause": this.paused = true; this.sentAt = undefined; this.finish(); return;
      case "resume": this.paused = false; return;
      case "pong": {
        if (m.id !== this.pingID || this.sentAt === undefined) return;
        const ms = this.o.now() - this.sentAt;
        this.sentAt = undefined;
        if (this.marked) this.o.send({ type: "recovered", ms: Math.round(ms) });
        this.finish();
      }
    }
  }

  private finish() {
    if (!this.marked) return;
    this.marked = false;
    this.o.clearMarker(this.session);
  }

  tick() {
    if (this.paused || !this.session) return;
    const t = this.o.now();
    if (this.sentAt === undefined) {
      this.pingID += 1;
      this.sentAt = t;
      this.sentEpoch = this.o.epoch();
      this.o.send({ type: "ping", id: this.pingID });
      return;
    }
    const waited = t - this.sentAt;
    if (waited < this.ongoingAfter) return;
    if (this.marked && t - this.lastWrite < this.updateEvery) return;
    this.marked = true;
    this.lastWrite = t;
    this.o.writeMarker({
      v: HANG_MARKER_VERSION, session: this.session, startedAt: this.sentEpoch, ms: Math.round(waited), updatedAt: this.o.epoch(),
      activity: this.activity, breadcrumbs: this.breadcrumbs,
    });
  }
}

// MARK: Bericht

const time = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 19);

/** Eine Zeile je Hänger für Bericht und Log: Zeit, Dauer, Quelle, Aktivität, Ursache, Breadcrumbs. */
export function hangLine(h: HangRecord): string {
  const parts = [`${time(h.at)} UTC`, `${formatHangMs(h.ms)}${h.ongoing ? "+ (still blocked at the end)" : ""}`, h.source];
  if (h.activity) parts.push(`during ${h.activity}`);
  if (h.culprit) parts.push(`in ${h.culprit}`);
  if (h.breadcrumbs.length) parts.push(`after ${h.breadcrumbs.join(" › ")}`);
  return parts.join(" · ");
}

export function hangStatsLine(s: HangStats): string {
  if (!s.count) return "no hangs";
  return `${s.count} hang${s.count === 1 ? "" : "s"} (main ${s.main}, input ${s.input}, store ${s.worker}) · blocked ${formatHangMs(s.blockedMs)} · p50 ${formatHangMs(s.p50)} · p95 ${formatHangMs(s.p95)} · max ${formatHangMs(s.max)}${s.freezes ? ` · ${s.freezes} over 2 s` : ""}`;
}

/** Abschnitt „hangs“ des kopierbaren Berichts: diese Sitzung und frühere. */
export function hangReportLines(current: readonly HangRecord[], previous: readonly HangSessionData[], limit = 30): string[] {
  const lines = [`hangs this session: ${hangStatsLine(hangStats(current))}`];
  for (const h of current.slice(-limit)) lines.push("  " + hangLine(h));
  for (const s of previous) {
    lines.push(`hangs in session from ${time(s.startedAt)} UTC: ${hangStatsLine(s.stats)}`);
    for (const h of s.hangs.slice(-10)) lines.push("  " + hangLine(h));
  }
  return lines;
}

/** Für Bündel (Problem melden, Absturzbericht): Kennzahlen und Hänger als Daten. */
export interface HangReport { stats: HangStats; hangs: HangRecord[]; previous: { startedAt: string; stats: HangStats; hangs: HangRecord[] }[] }

export function hangReport(current: readonly HangRecord[], previous: readonly HangSessionData[]): HangReport {
  return {
    stats: hangStats(current),
    hangs: current.slice(-50).map((h) => ({ ...h, breadcrumbs: [...h.breadcrumbs] })),
    previous: previous.map((s) => ({ startedAt: new Date(s.startedAt).toISOString(), stats: s.stats, hangs: s.hangs.slice(-20) })),
  };
}
