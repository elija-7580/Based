// BSD-266 (Whiteboard 4): Dateien auf dem Board in drei Stufen (Entscheidung Elija, 17.11.2026).
//   1 Objekt zum Draufschreiben: Bild, PDF (jede Seite ein Objekt – „Ausdruck“)
//   2 Vorschau: Text aller Art (auch Agent-Logs und Chat-Mitschriften), HTML, Video, Audio
//   3 Dateikarte: alles andere
// Hier: die Einordnung nach Name und Art sowie die lesbare Vorschau von Textdateien – ohne DOM, damit es getestet ist.

export type BoardFileView = "image" | "pdf" | "text" | "html" | "video" | "audio" | "card";

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "log", "json", "jsonl", "ndjson", "csv", "tsv", "yaml", "yml", "xml", "toml", "ini", "env", "conf",
  "ts", "tsx", "js", "jsx", "mjs", "py", "swift", "rs", "go", "java", "kt", "c", "h", "cpp", "cs", "rb", "php", "sh", "zsh", "sql", "css", "scss", "tex", "bib", "r",
]);
const TEXT_MIME = new Set(["application/json", "application/x-ndjson", "application/jsonl", "application/xml", "application/x-yaml", "application/yaml", "application/toml", "application/x-sh", "application/sql"]);

export const fileExtension = (name: string) => /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? "";

/** In welcher Form eine Datei auf dem Board erscheint. */
export function boardFileView(name: string, mime: string): BoardFileView {
  const ext = fileExtension(name);
  const m = mime.toLowerCase().split(";")[0]!.trim();
  // SVG kann Skripte tragen und wird als Bild nicht überall entpackt: als Text zeigen, nie ausführen.
  if (m === "image/svg+xml" || ext === "svg") return "text";
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf" || ext === "pdf") return "pdf";
  if (m === "text/html" || ext === "html" || ext === "htm") return "html";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/") || TEXT_MIME.has(m) || TEXT_EXT.has(ext)) return "text";
  return "card";
}

/** Eine Zeile der Vorschau: gewöhnlicher Text oder eine Wortmeldung aus einem Chat-/Agent-Log. */
export interface PreviewLine { role?: string; text: string }
export interface TextPreview { lines: PreviewLine[]; chat: boolean; /** Es gibt mehr, als gezeigt wird. */ more: boolean }

/** So viel einer Textdatei wird für die Vorschau gelesen bzw. gezeigt. */
export const PREVIEW_BYTES = 64 * 1024;
export const PREVIEW_LINES = 120;
const LINE_MAX = 600;

const clip = (s: string) => (s.length > LINE_MAX ? s.slice(0, LINE_MAX - 1) + "…" : s);

/** Text einer Wortmeldung: Zeichenkette oder Liste von Teilen (Text, Werkzeug-Aufruf, Werkzeug-Ergebnis). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const p of content) {
    if (typeof p === "string") parts.push(p);
    else if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      if (typeof o.text === "string") parts.push(o.text);
      else if (o.type === "tool_use" || o.type === "tool_call" || o.type === "function_call") parts.push(`[tool: ${typeof o.name === "string" ? o.name : "call"}]`);
      else if (o.type === "tool_result" || o.type === "function_call_output") parts.push("[tool result]");
      else if (o.type === "thinking" || o.type === "reasoning") parts.push("[thinking]");
    }
  }
  return parts.join(" ");
}

/** Wortmeldung aus einer JSON-Zeile lesen (gängige Formen: {role, content}, {type, message:{role, content}}, {speaker, text}). */
function chatLine(raw: unknown): PreviewLine | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const msg = (o.message && typeof o.message === "object" ? o.message : o.payload && typeof o.payload === "object" ? o.payload : o) as Record<string, unknown>;
  const role = [msg.role, o.role, o.speaker, o.author, o.type].find((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 24);
  const text = (messageText(msg.content) || messageText(o.content) || (typeof o.text === "string" ? o.text : "") || (typeof msg.text === "string" ? msg.text : "")).replace(/\s+/g, " ").trim();
  if (!role || !text) return undefined;
  return { role, text: clip(text) };
}

/**
 * Lesbare Vorschau einer Textdatei. Chat- und Agent-Logs (eine JSON-Wortmeldung je Zeile, oder ein JSON-Array bzw.
 * `{messages: […]}`) werden als Gespräch gezeigt: wer, was. Alles andere Zeile für Zeile. `truncated`: der Text ist
 * nur der Anfang der Datei (die letzte, womöglich halbe Zeile zählt dann nicht).
 */
export function textPreview(text: string, name: string, truncated = false): TextPreview {
  let rows = text.replace(/\r\n?/g, "\n").split("\n");
  if (truncated && rows.length > 1) rows = rows.slice(0, -1);
  const ext = fileExtension(name);
  const chat: PreviewLine[] = [];
  let tried = 0;
  if (ext === "jsonl" || ext === "ndjson" || ext === "log" || ext === "txt" || ext === "") {
    for (const row of rows) {
      const t = row.trim();
      if (!t.startsWith("{")) continue;
      tried += 1;
      try { const l = chatLine(JSON.parse(t)); if (l) chat.push(l); } catch { /* keine JSON-Zeile */ }
      if (chat.length > PREVIEW_LINES) break;
    }
  } else if (ext === "json" && !truncated) {
    try {
      const data: unknown = JSON.parse(text);
      const list = Array.isArray(data) ? data : data && typeof data === "object" && Array.isArray((data as { messages?: unknown }).messages) ? (data as { messages: unknown[] }).messages : [];
      tried = list.length;
      for (const item of list) { const l = chatLine(item); if (l) chat.push(l); if (chat.length > PREVIEW_LINES) break; }
    } catch { /* kein gültiges JSON: als Text zeigen */ }
  }
  // Als Gespräch nur, wenn die Datei im Wesentlichen daraus besteht.
  if (chat.length >= 2 && chat.length >= tried / 3) return { lines: chat.slice(0, PREVIEW_LINES), chat: true, more: truncated || chat.length > PREVIEW_LINES };
  const lines = rows.slice(0, PREVIEW_LINES).map((r) => ({ text: clip(r.replace(/\t/g, "  ")) }));
  while (lines.length && lines[lines.length - 1]!.text.trim() === "") lines.pop();
  return { lines, chat: false, more: truncated || rows.length > PREVIEW_LINES };
}
