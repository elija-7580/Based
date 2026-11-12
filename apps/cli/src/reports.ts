// BSD-319: `based reports` – Fehlerberichte („Problem melden“) der Mac-App auflisten, ohne Server. Ein Bericht ist ein
// Ordner ~/.config/based/reports/<id>/ mit report.json (Format based-bug-report) und ggf. screenshot.png. Agenten
// (Nachtschicht, Fable) lesen die Dateien direkt; die Wiedergabe als Test steht in apps/web/e2e/replay/.

export const reportsDir = (home: string) => `${home}/.config/based/reports`;

export interface ReportsIO {
  listDirs: (path: string) => string[];
  readFile: (path: string) => string | undefined;
  exists: (path: string) => boolean;
}

export interface ReportEntry {
  id: string;
  createdAt: string;
  note: string;
  events: number;
  layoutIssues: number;
  screenshot?: string;
  realText: boolean;
  /** Ordner des Berichts. */
  path: string;
}

/** Alle lesbaren Berichte, neueste zuerst. Kaputte oder fremde Ordner werden übersprungen. */
export function listReports(home: string, io: ReportsIO, limit?: number): ReportEntry[] {
  const dir = reportsDir(home);
  const out: ReportEntry[] = [];
  for (const id of io.listDirs(dir)) {
    if (!/^[\w-]{1,80}$/.test(id)) continue;
    const raw = io.readFile(`${dir}/${id}/report.json`);
    if (raw === undefined) continue;
    try {
      const b = JSON.parse(raw) as { format?: unknown; id?: unknown; createdAt?: unknown; note?: unknown; realText?: unknown; screenshot?: unknown; recording?: { events?: unknown }; layout?: { issues?: unknown } };
      if (b.format !== "based-bug-report") continue;
      const shot = typeof b.screenshot === "string" && io.exists(`${dir}/${id}/${b.screenshot}`) ? `${dir}/${id}/${b.screenshot}` : undefined;
      out.push({
        id, createdAt: typeof b.createdAt === "string" ? b.createdAt : "", note: typeof b.note === "string" ? b.note : "",
        events: Array.isArray(b.recording?.events) ? b.recording.events.length : 0,
        layoutIssues: Array.isArray(b.layout?.issues) ? b.layout.issues.length : 0,
        ...(shot ? { screenshot: shot } : {}), realText: b.realText === true, path: `${dir}/${id}`,
      });
    } catch { /* halb geschrieben */ }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return limit ? out.slice(0, limit) : out;
}

/** Ausgabe für Menschen (eine Zeile Kopf, Satz, Pfad) oder JSON. */
export function formatReports(list: readonly ReportEntry[], home: string, json: boolean): string {
  if (json) return JSON.stringify(list, null, 2);
  if (!list.length) return `No problem reports in ${reportsDir(home)} — press ⇧⌘B in Based Next to make one.`;
  return list.map((r) => {
    const when = r.createdAt ? r.createdAt.replace("T", " ").slice(0, 16) + " UTC" : "unknown time";
    const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
    const facts = [n(r.events, "event"), r.layoutIssues ? n(r.layoutIssues, "layout issue") : "", r.screenshot ? "screenshot" : "", r.realText ? "real text" : ""].filter(Boolean).join(", ");
    return `${r.id}  ${when}  (${facts})\n  ${r.note || "(no description)"}\n  ${r.path}`;
  }).join("\n\n");
}
