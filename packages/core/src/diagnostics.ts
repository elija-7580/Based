// BSD-227: Diagnose im Client – rotierendes Log ohne Nutzerinhalte, Sitzungs-Marke (unsauberes Ende erkennen),
// Hänger-Erkennung über Zeitgeber-Verzug (im Browser gibt es kein Stack-Sampling wie in Swift AppDiagnostics) und
// ein Bericht zum Kopieren. Rein, ohne DOM: Speicher, Uhr und Zeitgeber werden hineingereicht.

export type DiagnosticsLevel = "info" | "warning" | "error";
export interface DiagnosticsEntry { at: number; level: DiagnosticsLevel; message: string }

/** Wie viele Einträge das Log behält (ältere fallen heraus). */
export const LOG_LIMIT = 300;
const MESSAGE_LIMIT = 300;

/**
 * Was nie ins Log darf: Token und Geheimnisse, Bearer-Kopfzeilen, Abfrageteile von URLs, E-Mail-Adressen,
 * Text in Anführungszeichen (oft Seitentitel oder Inhalt aus Fehlermeldungen). Länge begrenzt.
 */
export function redact(message: string): string {
  let m = redactSecrets(message)
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1?‹…›")
    .replace(/“[^”]*”|"[^"\n]{1,200}"|'[^'\n]{1,200}'/g, "‹text›");
  m = m.replace(/\s+/g, " ").trim();
  return m.length > MESSAGE_LIMIT ? m.slice(0, MESSAGE_LIMIT - 1) + "…" : m;
}

/** Nur Geheimnisse schwärzen (Bearer, Token, E-Mail) – Text sonst unverändert (BSD-319: „echter Text“ im Bündel). */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer ‹redacted›")
    .replace(/\b(?:bdu|bdl|sk|sk-ant|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{6,}/g, "‹token›")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "‹email›");
}

/** Schlüssel-Wert-Speicher (localStorage oder ein Test-Doppel). Fehler beim Speichern werden geschluckt. */
export interface DiagnosticsStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export class DiagnosticsLog {
  private entries: DiagnosticsEntry[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now, initial: DiagnosticsEntry[] = []) {
    this.entries = initial.slice(-LOG_LIMIT);
  }

  add(level: DiagnosticsLevel, message: string) {
    this.entries = [...this.entries.slice(-(LOG_LIMIT - 1)), { at: this.now(), level, message: redact(message) }];
    for (const l of this.listeners) l();
  }

  get all(): readonly DiagnosticsEntry[] { return this.entries; }

  /** Für React `useSyncExternalStore` (gebunden). Nach jedem Eintrag ist `all` ein neues Array. */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };
  getSnapshot = (): readonly DiagnosticsEntry[] => this.entries;
}

export const formatEntry = (e: DiagnosticsEntry) => `${new Date(e.at).toISOString()} ${e.level.toUpperCase().padEnd(7)} ${e.message}`;

// MARK: Sitzung

export interface SessionRecord {
  startedAt: number;
  /** Letztes Lebenszeichen (Herzschlag). */
  lastBeat: number;
  /** Sauber beendet (Seite geschlossen, App beendet). */
  clean: boolean;
  /** Erkannte Hänger in dieser Sitzung. */
  stalls: number;
  /** Letzte Log-Einträge der Sitzung (für den Bericht nach einem Absturz). */
  log?: DiagnosticsEntry[];
  /** BSD-368: Was zuletzt lief (Start-Phase oder Ansicht, z. B. „route page“) – ohne Nutzerinhalte. */
  activity?: string;
  /** BSD-368: JS-Speicher beim letzten Herzschlag (MB; nur wo der Browser ihn nennt, z. B. Chromium). */
  heapMB?: number;
  /** BSD-368: höchster gesehener JS-Speicher der Sitzung (MB). */
  peakHeapMB?: number;
}

export const SESSION_KEY = "based.diagnostics.session";

function read(storage: DiagnosticsStorage, key: string): SessionRecord | undefined {
  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Partial<SessionRecord>;
    if (typeof v.startedAt !== "number" || typeof v.lastBeat !== "number") return undefined;
    return {
      startedAt: v.startedAt, lastBeat: v.lastBeat, clean: v.clean === true, stalls: typeof v.stalls === "number" ? v.stalls : 0,
      ...(Array.isArray(v.log) ? { log: v.log.slice(-50) } : {}),
      ...(typeof v.activity === "string" ? { activity: redact(v.activity).slice(0, 80) } : {}),
      ...(typeof v.heapMB === "number" ? { heapMB: v.heapMB } : {}),
      ...(typeof v.peakHeapMB === "number" ? { peakHeapMB: v.peakHeapMB } : {}),
    };
  } catch {
    return undefined;
  }
}

function write(storage: DiagnosticsStorage, key: string, v: SessionRecord) {
  try { storage.setItem(key, JSON.stringify(v)); } catch { /* voll oder gesperrt */ }
}

/**
 * Sitzung beginnen. Gibt die vorige Sitzung zurück (auch eine sauber beendete; `clean: false` = Absturz, Hänger
 * oder hart beendet). Mehrere Tabs: jeder Tab schreibt seine Marke; der zuletzt gestartete zählt.
 */
export function beginSession(storage: DiagnosticsStorage, now: number): SessionRecord | undefined {
  const previous = read(storage, SESSION_KEY);
  write(storage, SESSION_KEY, { startedAt: now, lastBeat: now, clean: false, stalls: 0 });
  return previous;
}

export function heartbeat(storage: DiagnosticsStorage, now: number, update: Partial<Pick<SessionRecord, "stalls" | "log" | "activity" | "heapMB">> = {}) {
  const cur = read(storage, SESSION_KEY);
  if (!cur) return;
  const next: SessionRecord = { ...cur, ...update, lastBeat: now, clean: false };
  if (update.heapMB !== undefined) next.peakHeapMB = Math.max(cur.peakHeapMB ?? 0, update.heapMB);
  // Wer noch schlägt, lebt: ein „sauber beendet“ (z. B. Fenster schließen, das dann doch offen blieb) gilt nicht mehr.
  write(storage, SESSION_KEY, next);
}

/** Stichworte zur Sitzung für Hinweis und Bericht: zuletzt aktiv, Speicher. */
function sessionDetails(prev: SessionRecord): string[] {
  const out: string[] = [];
  if (prev.activity) out.push(`last activity: ${prev.activity}`);
  if (prev.heapMB !== undefined) out.push(`memory ${prev.heapMB} MB${prev.peakHeapMB !== undefined && prev.peakHeapMB > prev.heapMB ? ` (peak ${prev.peakHeapMB} MB)` : ""}`);
  return out;
}

export function endSession(storage: DiagnosticsStorage, now: number, log?: DiagnosticsEntry[]) {
  const cur = read(storage, SESSION_KEY);
  if (!cur) return;
  write(storage, SESSION_KEY, { ...cur, lastBeat: now, clean: true, ...(log ? { log: log.slice(-50) } : {}) });
}

/** Ein Satz über die vorige Sitzung oder undefined, wenn sie sauber endete. */
export function previousSessionNotice(prev: SessionRecord | undefined): string | undefined {
  if (!prev || prev.clean) return undefined;
  const when = new Date(prev.lastBeat).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const details = [prev.stalls > 0 ? `${prev.stalls} freeze${prev.stalls === 1 ? "" : "s"}` : "", ...sessionDetails(prev)].filter(Boolean);
  return `Based didn't close normally last time (last sign of life ${when}${details.map((d) => `, ${d}`).join("")}).`;
}

// MARK: Hänger

export interface StallDetectorOptions {
  /** Abstand der Prüfungen (ms). */
  intervalMs?: number;
  /** Ab so viel Verspätung gilt der Hauptthread als hängend (ms). */
  thresholdMs?: number;
  /** Uhr für die Messung; Standard: `performance.now()` (monoton, steht im Ruhezustand des Rechners still). */
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (id: unknown) => void;
  onStall: (blockedMs: number) => void;
}

/**
 * Hänger erkennen: ein Zeitgeber, der viel zu spät kommt, heißt, dass der Hauptthread so lange blockiert war.
 * (Im Hintergrund drosseln Browser Zeitgeber – der Aufrufer stoppt den Detektor, wenn die Seite unsichtbar ist.)
 * BSD-331: gemessen wird monoton, nicht mit `Date.now()` – sonst zählt ein Ruhezustand des Macs oder eine verstellte
 * Systemuhr als „main thread blocked“, obwohl nichts blockiert war.
 */
export function startStallDetector(o: StallDetectorOptions): () => void {
  const interval = o.intervalMs ?? 1000, threshold = o.thresholdMs ?? 2000;
  const perf = globalThis.performance;
  const now = o.now ?? (typeof perf?.now === "function" ? () => perf.now() : Date.now);
  const set = o.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clear = o.clearInterval ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>));
  let last = now();
  const id = set(() => {
    const t = now();
    const late = t - last - interval;
    last = t;
    if (late >= threshold) o.onStall(late);
  }, interval);
  return () => clear(id);
}

// MARK: Bericht

export interface ReportFacts { [name: string]: string | number | boolean | undefined }

/** Bericht als Text: Fakten, vorige Sitzung, Log. Enthält keine Seiteninhalte (Log ist bereits geschwärzt). */
export function buildReport(facts: ReportFacts, previous: SessionRecord | undefined, log: readonly DiagnosticsEntry[], now: number, extra: readonly string[] = []): string {
  const lines = [`Based diagnostics · ${new Date(now).toISOString()}`, ""];
  for (const [k, v] of Object.entries(facts)) if (v !== undefined) lines.push(`${k}: ${redact(String(v))}`);
  lines.push("");
  if (previous) {
    lines.push(`previous session: started ${new Date(previous.startedAt).toISOString()}, last beat ${new Date(previous.lastBeat).toISOString()}, ${previous.clean ? "closed normally" : "ended unexpectedly"}, freezes ${previous.stalls}${sessionDetails(previous).map((d) => `, ${d}`).join("")}`);
    if (!previous.clean && previous.log?.length) {
      lines.push("previous session log (last entries):");
      for (const e of previous.log) lines.push("  " + formatEntry({ ...e, message: redact(e.message) }));
    }
  } else lines.push("previous session: none recorded");
  // BSD-418: weitere Abschnitte (Hänger) vor dem Log
  if (extra.length) lines.push("", ...extra);
  lines.push("", `log (${log.length} entries):`);
  for (const e of log) lines.push(formatEntry(e));
  return lines.join("\n") + "\n";
}
