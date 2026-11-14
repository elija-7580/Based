// BSD-276: Absturz- und Hängerbericht nach dem Neustart – opt-in, ohne Inhalte. Rein, ohne DOM: Sitzung (BSD-227),
// App-Fakten und Log werden hineingereicht. Das Bündel enthält nie Seiten, Titel, Text, Aufzeichnung oder Bildschirmfoto
// (dafür gibt es „Problem melden“, BSD-319, mit eigenem Häkchen); Log-Zeilen werden noch einmal geschwärzt.
// Senden aus der App gibt es noch nicht (kein Ziel-Endpunkt, kein Datenschutztext): Datei sichern oder kopieren.
import { redact, type DiagnosticsEntry, type SessionRecord } from "./diagnostics.js";
import { hangLine, type HangMarker, type HangSessionData, type HangStats } from "./hangs.js";

export const CRASH_REPORT_FORMAT = "based-crash-report";
export const CRASH_REPORT_VERSION = 1;
/** Einwilligung pro Gerät: nach Absturz/Hänger beim nächsten Start einen Bericht anbieten (Standard aus). */
export const CRASH_CONSENT_KEY = "based.feedback.crashReports";
/** Start der Sitzung, für die der Hinweis schon beantwortet wurde (nicht zweimal fragen). */
export const CRASH_HANDLED_KEY = "based.feedback.handledSession";
/** So viele Log-Zeilen der abgestürzten Sitzung kommen höchstens mit. */
export const CRASH_LOG_LIMIT = 50;

/** BSD-418: „hang“ = die Sitzung endete mitten in einem Hänger (Marker des Watchdog-Workers). */
export type CrashKind = "crash" | "freeze" | "hang";

export interface CrashReport {
  format: typeof CRASH_REPORT_FORMAT;
  version: typeof CRASH_REPORT_VERSION;
  id: string;
  createdAt: string;
  kind: CrashKind;
  app: { shell: "desktop" | "web"; version?: string; commit?: string; platform: string };
  session: { startedAt: string; lastSignOfLife: string; durationSeconds: number; freezes: number; endedNormally: boolean };
  log: { at: string; level: DiagnosticsEntry["level"]; message: string }[];
  /** BSD-418: der Hänger, in dem die Sitzung endete (fehlt in älteren Berichten). */
  hang?: { startedAt: string; ms: number; activity: string; breadcrumbs: string[] };
  /** BSD-418: Hänger der Sitzung (Kennzahlen und die letzten Einträge als Zeilen; fehlt in älteren Berichten). */
  hangs?: { stats: HangStats; lines: string[] };
}

/** Was nach der vorigen Sitzung anzubieten ist: Absturz (nicht sauber beendet), Hänger (sauber, aber eingefroren) oder nichts. */
export function crashKind(prev: SessionRecord | undefined, ongoing?: HangMarker): CrashKind | undefined {
  if (!prev) return undefined;
  if (ongoing) return "hang";
  if (!prev.clean) return "crash";
  return prev.stalls > 0 ? "freeze" : undefined;
}

/** Hinweis beim Start nur mit Einwilligung, nur nach Absturz/Hänger und nur einmal je Sitzung. */
export function shouldOfferCrashReport(prev: SessionRecord | undefined, consent: boolean, handledStartedAt: number | undefined, ongoing?: HangMarker): boolean {
  const kind = crashKind(prev, ongoing);
  if (!consent || kind === undefined || prev!.startedAt === handledStartedAt) return false;
  // Feedback 14. 11.: Ein Ende ohne jedes Anzeichen (kein Fehler, kein Hänger) ist fast immer gewollt – Update mit
  // Neustart, „Sofort beenden“, Neustart des Mac. Dafür kein Hinweis beim Start; der Satz bleibt im Diagnose-Log.
  return kind !== "crash" || endedWithTrouble(prev!);
}

/** Gab es in der Sitzung Anzeichen eines Problems (Hänger oder Fehler im Log)? */
export function endedWithTrouble(prev: SessionRecord): boolean {
  return prev.stalls > 0 || (prev.log ?? []).some((e) => e?.level === "error");
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Das Bündel: Art, App (ohne User-Agent), Zeiten der Sitzung, letzte Log-Zeilen (geschwärzt). Keine Nutzerinhalte.
 * `prev` muss eine Sitzung mit Absturz oder Hänger sein (sonst undefined).
 */
export function buildCrashReport(input: { prev: SessionRecord | undefined; app: CrashReport["app"]; now: number; ongoing?: HangMarker | undefined; hangs?: HangSessionData | undefined }): CrashReport | undefined {
  const { prev, app, now, ongoing, hangs } = input;
  const kind = crashKind(prev, ongoing);
  if (!prev || !kind) return undefined;
  const log = (prev.log ?? []).flatMap((e) =>
    typeof e?.at === "number" && (e.level === "info" || e.level === "warning" || e.level === "error") && typeof e.message === "string"
      ? [{ at: iso(e.at), level: e.level, message: redact(e.message) }] : []).slice(-CRASH_LOG_LIMIT);
  return {
    format: CRASH_REPORT_FORMAT,
    version: CRASH_REPORT_VERSION,
    id: `crash-${iso(prev.startedAt).replace(/[-:.]/g, "").slice(0, 15)}`,
    createdAt: iso(now),
    kind,
    app: {
      shell: app.shell, ...(app.version ? { version: app.version } : {}), ...(app.commit ? { commit: app.commit } : {}),
      platform: redact(app.platform).slice(0, 40),
    },
    session: {
      startedAt: iso(prev.startedAt), lastSignOfLife: iso(prev.lastBeat), durationSeconds: Math.max(0, Math.round((prev.lastBeat - prev.startedAt) / 1000)),
      freezes: prev.stalls, endedNormally: prev.clean,
    },
    log,
    ...(ongoing ? { hang: { startedAt: iso(ongoing.startedAt), ms: Math.round(ongoing.ms), activity: redact(ongoing.activity), breadcrumbs: ongoing.breadcrumbs.map((c) => redact(c)) } } : {}),
    ...(hangs && hangs.stats.count ? { hangs: { stats: hangs.stats, lines: hangs.hangs.slice(-20).map(hangLine) } } : {}),
  };
}

/** Als Text zum Kopieren bzw. als Datei (`<id>.json`). */
export const crashReportText = (r: CrashReport) => JSON.stringify(r, null, 1);

/** Eine Zeile für den Hinweis: Zeitraum der Sitzung (UTC) und Hänger. */
export function crashReportSummary(r: CrashReport): string {
  const start = r.session.startedAt.replace("T", " ").slice(0, 16), end = r.session.lastSignOfLife.replace("T", " ").slice(0, 16);
  const until = end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end;
  const n = r.session.freezes;
  const hang = r.hang ? ` · hung ${Math.max(2, Math.floor(r.hang.ms / 1000))} s+${r.hang.activity ? ` during ${r.hang.activity}` : ""}` : "";
  return `Session ${start}–${until} UTC${n ? ` · ${n} freeze${n === 1 ? "" : "s"}` : ""}${hang}`;
}
