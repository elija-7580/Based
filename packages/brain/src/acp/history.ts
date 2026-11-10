// BSD-223 Teil 3: CLI-Verlauf (Port von Swift `CLISessionIndex`). Claude Code schreibt Gespräche nach
// `~/.claude/projects/<cwd>/<id>.jsonl`, Codex nach `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Hier nur das
// Lesen der Zeilen (rein, testbar); Dateien durchsuchen macht die Hülle (`acp/stdio.ts`). Nur lesend.
// Das Transkript kommt als ChatEvents, damit Chat-/Konsolen-Ansicht und Agentenwechsel es wie jede Sitzung nutzen.
import type { JSONValue } from "@based/core";
import type { StoredChatEvent } from "../events.js";

export type CliTool = "claude" | "codex";

export interface CliSession {
  id: string;
  tool: CliTool;
  title: string;
  cwd: string;
  file: string;
  /** ms seit 1970 */
  startedAt: number | undefined;
  updatedAt: number;
  gitBranch: string | undefined;
  sizeBytes: number;
}

type Obj = { [k: string]: JSONValue };
const obj = (v: JSONValue | undefined): Obj | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v : undefined);
const s = (v: JSONValue | undefined): string | undefined => (typeof v === "string" ? v : undefined);

function parseLine(line: string): Obj | undefined {
  if (line.trim() === "") return undefined;
  try { return obj(JSON.parse(line) as JSONValue); } catch { return undefined; }
}

export function cliDate(v: JSONValue | undefined): number | undefined {
  const t = s(v);
  if (!t) return undefined;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Klartext einer Claude-/Codex-Nachricht (`content` als Text oder Blöcke). */
export function cliContentText(content: JSONValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((b) => {
    const o = obj(b);
    const t = o?.type;
    return (t === "text" || t === "input_text" || t === "output_text") && typeof o?.text === "string" ? [o.text] : [];
  }).join("\n");
}

/** Vom CLI eingefügter Rauschtext (Befehle, Umgebung, Abbruch), kein echter Nutzertext. */
export function isCliNoise(text: string): boolean {
  const t = text.trim();
  return t === "" || t.startsWith("<command-") || t.startsWith("<local-command") || t.startsWith("Caveat:") ||
    t.startsWith("<environment_context>") || t.startsWith("<user_instructions>") || t.startsWith("[Request interrupted");
}

export function cliTitleLine(text: string): string {
  const one = text.trim().split("\n")[0] ?? text;
  return [...one].length > 90 ? [...one].slice(0, 87).join("") + "…" : one;
}

export interface CliFileInfo { path: string; mtime: number; size: number }

/** Claude-Code-Sitzung aus Kopf- und Endzeilen; `undefined`, wenn nichts Brauchbares drinsteht. */
export function claudeCliSession(file: CliFileInfo, head: readonly string[], tail: readonly string[]): CliSession | undefined {
  let id = (file.path.split("/").pop() ?? "").replace(/\.jsonl$/, "");
  let cwd = "", title = "", summary = "";
  let branch: string | undefined, started: number | undefined, updated: number | undefined;
  for (const line of head) {
    const v = parseLine(line);
    if (!v) continue;
    const sid = s(v.sessionId);
    if (sid) id = sid;
    if (!cwd && s(v.cwd)) cwd = s(v.cwd)!;
    if (branch === undefined && s(v.gitBranch)) branch = s(v.gitBranch);
    started ??= cliDate(v.timestamp);
    if (v.type === "summary" && !summary && s(v.summary)) summary = s(v.summary)!;
    if (!title && v.type === "user" && v.isMeta !== true && v.isSidechain !== true) {
      const t = cliContentText(obj(v.message)?.content);
      if (!isCliNoise(t)) title = cliTitleLine(t);
    }
  }
  for (const line of [...tail].reverse()) {
    const d = cliDate(parseLine(line)?.timestamp);
    if (d !== undefined) { updated = d; break; }
  }
  if (started === undefined && !title && !summary) return undefined;
  return {
    id, tool: "claude", title: summary || title || "Claude Code session", cwd, file: file.path,
    startedAt: started, updatedAt: updated ?? file.mtime, gitBranch: branch || undefined, sizeBytes: file.size,
  };
}

/** Codex-Sitzung (`rollout-<zeit>-<uuid>.jsonl`). */
export function codexCliSession(file: CliFileInfo, head: readonly string[]): CliSession {
  let id = "", cwd = "", title = "";
  let started: number | undefined;
  for (const line of head) {
    const v = parseLine(line);
    if (!v) continue;
    const p = obj(v.payload) ?? v;
    if (v.type === "session_meta" || (p.id !== undefined && p.cwd !== undefined)) {
      if (!id) id = s(p.id) ?? "";
      if (!cwd) cwd = s(p.cwd) ?? "";
      started ??= cliDate(p.timestamp ?? v.timestamp);
    }
    if (!cwd && s(p.cwd)) cwd = s(p.cwd)!;
    if (!title && p.type === "message" && p.role === "user") {
      const t = cliContentText(p.content);
      if (!isCliNoise(t)) title = cliTitleLine(t);
    }
  }
  if (!id) id = (file.path.split("/").pop() ?? "").replace(/\.jsonl$/, "").slice(-36);
  return { id, tool: "codex", title: title || "Codex session", cwd, file: file.path, startedAt: started, updatedAt: file.mtime, gitBranch: undefined, sizeBytes: file.size };
}

/** Werkzeug-Titel wie Claude Code („Bash npm test“, „Read src/a.ts“, „github:create_issue“). */
export function claudeToolTitle(tool: string, input: JSONValue | undefined): { name: string; arg: string | undefined } {
  const i = obj(input) ?? {};
  const g = (k: string) => s(i[k]);
  let arg: string | undefined;
  switch (tool) {
    case "Bash": arg = g("command"); break;
    case "Read": case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": case "NotebookRead": arg = g("file_path") ?? g("notebook_path"); break;
    case "Grep": { const p = g("pattern"); arg = p !== undefined ? (g("path") ? `${p} in ${g("path")}` : p) : undefined; break; }
    case "Glob": arg = g("pattern"); break;
    case "LS": arg = g("path"); break;
    case "WebFetch": arg = g("url"); break;
    case "WebSearch": arg = g("query"); break;
    case "Task": case "Agent": arg = g("description"); break;
    case "TodoWrite": arg = undefined; break;
    default: arg = Object.keys(i).sort().map((k) => s(i[k])).find((x) => x !== undefined);
  }
  let name = tool;
  if (tool.startsWith("mcp__")) {
    const parts = tool.split("__").filter((x) => x !== "");
    const server = parts[1] ?? "mcp";
    name = `${server}:${parts.length > 2 ? parts.slice(2).join("__") : server}`;
  }
  return { name, arg };
}

/** Text eines Claude-`tool_result` (Text oder Blöcke). */
function resultText(content: JSONValue | undefined): string {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).flatMap((b) => { const o = obj(b); return o?.type === "text" && typeof o.text === "string" ? [o.text] : []; }).join("\n");
}

const RESULT_LIMIT = 4000;

/**
 * Gespräch als ChatEvents (Nutzer, Text, Thinking, Werkzeuge mit Ergebnis). Höchstens `limit` Ereignisse, die
 * neuesten. Jede Nutzer-Nachricht schließt den vorigen Turn mit `result` ab, damit Ansicht und Verlauf Turns sehen.
 */
export function cliTranscript(tool: CliTool, text: string, limit = 3000): StoredChatEvent[] {
  const out: StoredChatEvent[] = [];
  let open = false;
  let n = 0;
  const endTurn = () => { if (open) out.push({ type: "result", text: "", isError: false }); open = false; };
  const user = (t: string, at: number | undefined) => { endTurn(); out.push(at !== undefined ? { type: "userMessage", text: t.trim(), at } : { type: "userMessage", text: t.trim() }); open = true; };
  const push = (e: StoredChatEvent) => { out.push(e); open = true; };
  const toolId = (raw: string | undefined) => raw ?? `cli-${++n}`;
  for (const line of text.split("\n")) {
    const v = parseLine(line);
    if (!v) continue;
    const at = cliDate(v.timestamp);
    if (tool === "codex") {
      const p = obj(v.payload) ?? v;
      switch (p.type) {
        case "message": {
          const t = cliContentText(p.content);
          if (p.role === "user") { if (!isCliNoise(t)) user(t, at); }
          else if (p.role === "assistant" && t.trim()) push({ type: "text", text: t.trim() });
          break;
        }
        case "reasoning": {
          const t = (Array.isArray(p.summary) ? p.summary : []).flatMap((x) => { const o = obj(x); return typeof o?.text === "string" ? [o.text] : []; }).join("\n");
          if (t.trim()) push({ type: "thinking", text: t.trim() });
          break;
        }
        case "function_call": case "local_shell_call": case "custom_tool_call": {
          const args = s(p.arguments) ?? s(p.input) ?? "";
          let detail = args;
          try {
            const j = obj(JSON.parse(args) as JSONValue);
            const cmd = j?.command;
            if (Array.isArray(cmd)) detail = cmd.filter((x): x is string => typeof x === "string").join(" ");
            else if (typeof cmd === "string") detail = cmd;
          } catch { /* Argumente sind kein JSON */ }
          push({ type: "toolUse", id: toolId(s(p.call_id)), name: s(p.name) ?? "shell", input: { command: detail } });
          break;
        }
        case "function_call_output": case "custom_tool_call_output": {
          let o = s(p.output) ?? "";
          try { const j = obj(JSON.parse(o) as JSONValue); if (typeof j?.output === "string") o = j.output; } catch { /* Text */ }
          push({ type: "toolResult", id: toolId(s(p.call_id)), output: o.slice(0, RESULT_LIMIT), isError: false });
          break;
        }
      }
      continue;
    }
    switch (v.type) {
      case "summary": if (s(v.summary)) out.push({ type: "notice", text: `Summary: ${s(v.summary)}` }); break;
      case "user": {
        if (v.isMeta === true) break;
        const content = obj(v.message)?.content;
        const blocks = Array.isArray(content) ? content.map(obj) : [];
        if (blocks.some((b) => b?.type === "tool_result")) {
          for (const b of blocks) if (b?.type === "tool_result") push({ type: "toolResult", id: toolId(s(b.tool_use_id)), output: resultText(b.content).slice(0, RESULT_LIMIT), isError: b.is_error === true });
        } else {
          const t = cliContentText(content);
          if (!isCliNoise(t)) user(t, at);
        }
        break;
      }
      case "assistant": {
        const content = obj(v.message)?.content;
        for (const raw of Array.isArray(content) ? content : []) {
          const b = obj(raw);
          if (b?.type === "text" && s(b.text)?.trim()) push({ type: "text", text: s(b.text)!.trim() });
          else if (b?.type === "thinking" && s(b.thinking)?.trim()) push({ type: "thinking", text: s(b.thinking)!.trim() });
          else if (b?.type === "tool_use") {
            const t = claudeToolTitle(s(b.name) ?? "tool", b.input);
            push({ type: "toolUse", id: toolId(s(b.id)), name: t.name, input: obj(b.input) ?? {} });
          }
        }
        break;
      }
    }
  }
  endTurn();
  return out.length > limit ? out.slice(out.length - limit) : out;
}

/** Shell-Befehl, der das Gespräch im Terminal fortsetzt. */
export function cliResumeCommand(x: Pick<CliSession, "tool" | "id" | "cwd">): string {
  const dir = x.cwd === "" ? "~" : `'${x.cwd.replace(/'/g, `'\\''`)}'`;
  const id = x.id.replace(/[^A-Za-z0-9_-]/g, "");
  return x.tool === "codex" ? `cd ${dir} && codex resume ${id}` : `cd ${dir} && claude --resume ${id}`;
}

/** Nach Arbeitsordner gruppiert, zuletzt aktives Projekt zuerst. */
export function cliSessionsByProject(sessions: readonly CliSession[]): { cwd: string; project: string; sessions: CliSession[] }[] {
  const groups = new Map<string, CliSession[]>();
  for (const x of sessions) groups.set(x.cwd, [...(groups.get(x.cwd) ?? []), x]);
  return [...groups].map(([cwd, list]) => ({ cwd, project: cwd === "" ? "Unknown" : cwd.split("/").filter(Boolean).pop() ?? cwd, sessions: list.sort((a, b) => b.updatedAt - a.updatedAt) }))
    .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
}
