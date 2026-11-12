// BSD-276: Absturz- und Hängerbericht nach dem Neustart – opt-in, ohne Inhalte. Rein, ohne DOM: Sitzung (BSD-227),
// App-Fakten und Log werden hineingereicht. Das Bündel enthält nie Seiten, Titel, Text, Aufzeichnung oder Bildschirmfoto
// (dafür gibt es „Problem melden“, BSD-319, mit eigenem Häkchen); Log-Zeilen werden noch einmal geschwärzt.
// Senden aus der App gibt es noch nicht (kein Ziel-Endpunkt, kein Datenschutztext): Datei sichern oder kopieren.
import { redact, type DiagnosticsEntry, type SessionRecord } from "./diagnostics.js";

export const CRASH_REPORT_FORMAT = "based-crash-report";
export const CRASH_REPORT_VERSION = 1;
/** Einwilligung pro Gerät: nach Absturz/Hänger beim nächsten Start einen Bericht anbieten (Standard aus). */
export const CRASH_CONSENT_KEY = "based.feedback.crashReports";
/** Start der Sitzung, für die der Hinweis schon beantwortet wurde (nicht zweimal fragen). */
export const CRASH_HANDLED_KEY = "based.feedback.handledSession";
/** So viele Log-Zeilen der abgestürzten Sitzung kommen höchstens mit. */
export const CRASH_LOG_LIMIT = 50;

export type CrashKind = "crash" | "freeze";

export interface CrashReport {
  format: typeof CRASH_REPORT_FORMAT;
  version: typeof CRASH_REPORT_VERSION;
  id: string;
  createdAt: string;
  kind: CrashKind;
  app: { shell: "desktop" | "web"; version?: string; commit?: string; platform: string };
  session: { startedAt: string; lastSignOfLife: string; durationSeconds: number; freezes: number; endedNormally: boolean };
  log: { at: string; level: DiagnosticsEntry["level"]; message: string }[];
}

/** Was nach der vorigen Sitzung anzubieten ist: Absturz (nicht sauber beendet), Hänger (sauber, aber eingefroren) oder nichts. */
export function crashKind(prev: SessionRecord | undefined): CrashKind | undefined {
  if (!prev) return undefined;
  if (!prev.clean) return "crash";
  return prev.stalls > 0 ? "freeze" : undefined;
}

/** Hinweis beim Start nur mit Einwilligung, nur nach Absturz/Hänger und nur einmal je Sitzung. */
export function shouldOfferCrashReport(prev: SessionRecord | undefined, consent: boolean, handledStartedAt: number | undefined): boolean {
  return consent && crashKind(prev) !== undefined && prev!.startedAt !== handledStartedAt;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Das Bündel: Art, App (ohne User-Agent), Zeiten der Sitzung, letzte Log-Zeilen (geschwärzt). Keine Nutzerinhalte.
 * `prev` muss eine Sitzung mit Absturz oder Hänger sein (sonst undefined).
 */
export function buildCrashReport(input: { prev: SessionRecord | undefined; app: CrashReport["app"]; now: number }): CrashReport | undefined {
  const { prev, app, now } = input;
  const kind = crashKind(prev);
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
  };
}

/** Als Text zum Kopieren bzw. als Datei (`<id>.json`). */
export const crashReportText = (r: CrashReport) => JSON.stringify(r, null, 1);

/** Eine Zeile für den Hinweis: Zeitraum der Sitzung (UTC) und Hänger. */
export function crashReportSummary(r: CrashReport): string {
  const start = r.session.startedAt.replace("T", " ").slice(0, 16), end = r.session.lastSignOfLife.replace("T", " ").slice(0, 16);
  const until = end.slice(0, 10) === start.slice(0, 10) ? end.slice(11) : end;
  const n = r.session.freezes;
  return `Session ${start}–${until} UTC${n ? ` · ${n} freeze${n === 1 ? "" : "s"}` : ""}`;
}
