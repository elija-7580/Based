// BSD-223 Teil 3: CLI-Verlauf (Claude Code, Codex) und Setup-Doctor. Dateien in einem Test-Home.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentStatus, claudeCliSession, claudeLoginFrom, cliResumeCommand, cliSessionsByProject, cliTranscript, codexCliSession,
  DEFAULT_AGENTS, isCliNoise, toolCatalog, unapprovedKeys, ChatTurnBuilder, TranscriptBuilder, historyFromEvents,
  type DoctorTool, type StatusContext,
} from "../src/index.js";
import { claudeLoggedIn, probeTools, readCliTranscript, scanCliSessions, which } from "../src/acp/stdio.js";

const j = (o: unknown) => JSON.stringify(o);

const CLAUDE = [
  j({ type: "summary", summary: "Fix the login bug", leafUuid: "x" }),
  j({ type: "user", isMeta: true, sessionId: "abc-1", cwd: "/p/web", timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "<command-name>/init</command-name>" } }),
  j({ type: "user", sessionId: "abc-1", cwd: "/p/web", gitBranch: "main", timestamp: "2026-11-01T10:00:01.000Z", message: { role: "user", content: "Why does login fail?" } }),
  j({ type: "assistant", timestamp: "2026-11-01T10:00:05.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Check auth.ts" }, { type: "text", text: "Let me look." }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/p/web/auth.ts" } }] } }),
  j({ type: "user", timestamp: "2026-11-01T10:00:06.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "export const x = 1" }] }] } }),
  j({ type: "assistant", timestamp: "2026-11-01T10:00:09.000Z", message: { role: "assistant", content: [{ type: "text", text: "Token expired." }, { type: "tool_use", id: "tu2", name: "mcp__github__create_issue", input: { title: "Login" } }] } }),
  "{broken",
  j({ type: "user", timestamp: "2026-11-01T10:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "thanks" }] } }),
].join("\n");

const CODEX = [
  j({ timestamp: "2026-11-02T08:00:00.000Z", type: "session_meta", payload: { id: "0199-uuid", cwd: "/p/api", timestamp: "2026-11-02T08:00:00.000Z" } }),
  j({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] } }),
  j({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a health route" }] } }),
  j({ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Need a route" }] } }),
  j({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: j({ command: ["bash", "-lc", "ls"] }) } }),
  j({ type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: j({ output: "src\n" }) } }),
  j({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
].join("\n");

function home() {
  const h = mkdtempSync(join(tmpdir(), "home-"));
  mkdirSync(join(h, ".claude", "projects", "-p-web"), { recursive: true });
  writeFileSync(join(h, ".claude", "projects", "-p-web", "abc-1.jsonl"), CLAUDE);
  writeFileSync(join(h, ".claude", "projects", "-p-web", "empty.jsonl"), "");
  mkdirSync(join(h, ".codex", "sessions", "2026", "11", "02"), { recursive: true });
  writeFileSync(join(h, ".codex", "sessions", "2026", "11", "02", "rollout-2026-11-02T08-00-00-0199-uuid.jsonl"), CODEX);
  writeFileSync(join(h, ".codex", "sessions", "2026", "11", "02", "other.jsonl"), CODEX);
  return h;
}

describe("CLI-Verlauf", () => {
  it("Claude-Sitzung: Zusammenfassung als Titel, ID/Ordner/Branch, letzte Zeit aus dem Ende", () => {
    const s = claudeCliSession({ path: "/x/abc-1.jsonl", mtime: 5, size: 10 }, CLAUDE.split("\n"), CLAUDE.split("\n"))!;
    expect(s).toMatchObject({ id: "abc-1", tool: "claude", title: "Fix the login bug", cwd: "/p/web", gitBranch: "main", startedAt: Date.parse("2026-11-01T10:00:00.000Z"), updatedAt: Date.parse("2026-11-01T10:01:00.000Z") });
    const noSummary = CLAUDE.split("\n").slice(1);
    expect(claudeCliSession({ path: "/x/abc-1.jsonl", mtime: 5, size: 10 }, noSummary, [])!.title).toBe("Why does login fail?");
    expect(claudeCliSession({ path: "/x/e.jsonl", mtime: 5, size: 0 }, [""], [])).toBeUndefined();
  });

  it("Codex-Sitzung: Meta, Rauschen übersprungen, ID notfalls aus dem Dateinamen", () => {
    expect(codexCliSession({ path: "/x/rollout-a.jsonl", mtime: 7, size: 1 }, CODEX.split("\n"))).toMatchObject({ id: "0199-uuid", cwd: "/p/api", title: "Add a health route", updatedAt: 7 });
    const id = "12345678-1234-1234-1234-123456789abc";
    expect(codexCliSession({ path: `/x/rollout-2026-01-01T10-00-00-${id}.jsonl`, mtime: 7, size: 1 }, []).id).toBe(id);
  });

  it("Transkript als ChatEvents (Turns, Werkzeuge mit Ergebnis, MCP-Namen), nutzbar für Ansicht und Übergabe", () => {
    const ev = cliTranscript("claude", CLAUDE);
    expect(ev.map((e) => e.type)).toEqual(["userMessage", "thinking", "text", "toolUse", "toolResult", "text", "toolUse", "result", "userMessage", "result"]);
    expect(ev.find((e) => e.type === "toolUse")).toMatchObject({ id: "tu1", name: "Read", input: { file_path: "/p/web/auth.ts" } });
    expect(ev.filter((e) => e.type === "toolUse")[1]).toMatchObject({ name: "github:create_issue" });
    expect(ev.find((e) => e.type === "toolResult")).toMatchObject({ id: "tu1", output: "export const x = 1" });
    const t = new TranscriptBuilder();
    for (const e of ev) t.apply(e);
    expect(historyFromEvents(ev).filter((m) => m.role === "user").map((m) => m.content)).toEqual(["Why does login fail?", "thanks"]);
    const codex = cliTranscript("codex", CODEX);
    expect(codex.map((e) => e.type)).toEqual(["userMessage", "thinking", "toolUse", "toolResult", "text", "result"]);
    expect(codex[2]).toMatchObject({ name: "shell", input: { command: "bash -lc ls" } });
    expect(codex[3]).toMatchObject({ output: "src\n" });
    const b = new ChatTurnBuilder();
    for (const e of codex.slice(1)) b.apply(e);
    expect(b.parts.find((p) => p.kind === "tool")).toMatchObject({ status: "done", output: "src\n" });
    expect(cliTranscript("claude", CLAUDE, 2)).toHaveLength(2);
  });

  it("Fortsetzen-Befehl quotet den Ordner; Gruppen nach Projekt", () => {
    expect(cliResumeCommand({ tool: "claude", id: "abc-1", cwd: "/p/it's" })).toBe("cd '/p/it'\\''s' && claude --resume abc-1");
    expect(cliResumeCommand({ tool: "codex", id: "x;rm -rf /", cwd: "" })).toBe("cd ~ && codex resume xrm-rf");
    const g = cliSessionsByProject([
      { id: "1", tool: "claude", title: "", cwd: "/a/web", file: "", startedAt: 0, updatedAt: 1, gitBranch: undefined, sizeBytes: 0 },
      { id: "2", tool: "codex", title: "", cwd: "/a/api", file: "", startedAt: 0, updatedAt: 5, gitBranch: undefined, sizeBytes: 0 },
      { id: "3", tool: "claude", title: "", cwd: "/a/web", file: "", startedAt: 0, updatedAt: 3, gitBranch: undefined, sizeBytes: 0 },
    ]);
    expect(g.map((x) => [x.project, x.sessions.map((s) => s.id)])).toEqual([["api", ["2"]], ["web", ["3", "1"]]]);
    expect(isCliNoise("[Request interrupted by user]")).toBe(true);
  });

  it("Dateien durchsuchen (nur rollout-*.jsonl bei Codex) und Transkript lesen", async () => {
    const h = home();
    const list = await scanCliSessions(h);
    expect(list.map((s) => [s.tool, s.id])).toEqual([["codex", "0199-uuid"], ["claude", "abc-1"]]);
    expect((await readCliTranscript(list[1]!)).filter((e) => e.type === "userMessage")).toHaveLength(2);
    expect(await scanCliSessions(join(h, "nowhere"))).toEqual([]);
  });
});

describe("Setup-Doctor", () => {
  const tools = (have: Record<string, boolean>): DoctorTool[] => toolCatalog("darwin").map((t) => ({ ...t, path: have[t.id] ? `/usr/bin/${t.id}` : undefined, version: have[t.id] ? "1.0" : undefined }));
  const ctx = (o: Partial<StatusContext> = {}): StatusContext => ({ claudeLoggedIn: true, unapprovedKeys: () => [], found: () => false, approveHint: (a, n) => `BASED_CODING_ENV=${a}=${n.join(",")}`, ...o });
  const claude = DEFAULT_AGENTS.find((a) => a.id === "claude")!, codex = DEFAULT_AGENTS.find((a) => a.id === "codex")!, gemini = DEFAULT_AGENTS.find((a) => a.id === "gemini")!;

  it("Claude: bereit, Login fehlt, Schlüssel nicht freigegeben", () => {
    const all = tools({ node: true, npx: true, claude: true });
    expect(agentStatus(claude, all, ctx())).toMatchObject({ state: "ready" });
    expect(agentStatus(claude, all, ctx({ claudeLoggedIn: false }))).toMatchObject({ state: "needsLogin", fix: "claude" });
    expect(agentStatus(claude, all, ctx({ claudeLoggedIn: false, unapprovedKeys: () => ["ANTHROPIC_API_KEY"] })))
      .toMatchObject({ state: "needsLogin", fix: "BASED_CODING_ENV=claude=ANTHROPIC_API_KEY" });
  });

  it("npx-Agenten: Node fehlt, CLI fehlt, bereit; eigener Befehl im PATH", () => {
    expect(agentStatus(codex, tools({}), ctx())).toMatchObject({ state: "missing", fix: "brew install node" });
    expect(agentStatus(codex, tools({ node: true, npx: true }), ctx())).toMatchObject({ state: "missing", fix: "npm install -g @openai/codex" });
    expect(agentStatus(codex, tools({ node: true, npx: true, codex: true }), ctx())).toMatchObject({ state: "ready" });
    expect(agentStatus(gemini, tools({}), ctx())).toMatchObject({ state: "missing", fix: "npm install -g @google/gemini-cli" });
    expect(agentStatus(gemini, tools({}), ctx({ found: (c) => c === "gemini" }))).toMatchObject({ state: "ready" });
  });

  it("Login-Erkennung und nicht freigegebene Schlüssel", () => {
    expect(claudeLoginFrom({ credentials: false, claudeJson: '{"oauthAccount":{}}' }, {})).toBe(true);
    expect(claudeLoginFrom({ credentials: false, claudeJson: "{}" }, {})).toBe(false);
    expect(claudeLoginFrom({ credentials: false, claudeJson: undefined }, { ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(unapprovedKeys("claude", { ANTHROPIC_API_KEY: "k" }, [])).toEqual(["ANTHROPIC_API_KEY"]);
    expect(unapprovedKeys("claude", { ANTHROPIC_API_KEY: "k" }, ["ANTHROPIC_API_KEY"])).toEqual([]);
  });

  it("Node: which, Werkzeuge prüfen, Login-Dateien", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bin-"));
    writeFileSync(join(dir, "codex"), "#!/bin/sh\necho codex-cli 0.9.1\n");
    chmodSync(join(dir, "codex"), 0o755);
    writeFileSync(join(dir, "notexec"), "x");
    expect(await which("codex", { PATH: dir })).toBe(join(dir, "codex"));
    expect(await which("notexec", { PATH: dir })).toBeUndefined();
    const probed = await probeTools({ PATH: dir });
    expect(probed.find((t) => t.id === "codex")).toMatchObject({ path: join(dir, "codex"), version: "codex-cli 0.9.1" });
    expect(probed.find((t) => t.id === "node")!.path).toBeUndefined();
    const h = home();
    expect(await claudeLoggedIn(h, {})).toBe(false);
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(join(h, ".claude", ".credentials.json"), "{}");
    expect(await claudeLoggedIn(h, {})).toBe(true);
  });
});
