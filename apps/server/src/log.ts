// Strukturierte Logs (JSONL auf stderr, journald/docker logs nehmen sie auf). Grundsatz: keine Nutzerinhalte –
// nur Methode, Pfad ohne Query, Status, Dauer, Zähler. Titel, Texte, Tokens und Bodies kommen nie ins Log.

export type LogLevel = "debug" | "info" | "warning" | "error";
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };

export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warning(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
}

export function createLogger(opts: { minimum?: LogLevel; write?: (line: string) => void; category?: string } = {}): Logger {
  const minimum = opts.minimum ?? "info";
  const write = opts.write ?? ((line: string) => void process.stderr.write(line + "\n"));
  const category = opts.category ?? "server";
  const log = (level: LogLevel, message: string, fields: LogFields = {}) => {
    if (ORDER[level] < ORDER[minimum]) return;
    const entry: Record<string, unknown> = { t: new Date().toISOString(), level, category, message };
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) entry[k] = v;
    write(JSON.stringify(entry));
  };
  return {
    log,
    info: (m, f) => log("info", m, f),
    warning: (m, f) => log("warning", m, f),
    error: (m, f) => log("error", m, f),
    debug: (m, f) => log("debug", m, f),
  };
}

/** Logger, der nichts schreibt (Tests). */
export const silentLogger: Logger = createLogger({ write: () => {} });

export function parseLogLevel(s: string | undefined): LogLevel | undefined {
  return s === "debug" || s === "info" || s === "warning" || s === "error" ? s : undefined;
}
