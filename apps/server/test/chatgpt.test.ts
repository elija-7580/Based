// BSD-257: „Mit ChatGPT anmelden“ über den Codex-Login. Fake-Codex-CLI (angemeldet / nicht angemeldet / API-Key /
// fehlt) für `GET /coding/chatgpt`, dann Chat-Turns über CodexChatEngine → CodingClient → Server → Fake-ACP-Agent
// (als „codex“ eingetragen): Antwort, Folge-Turn in derselben Sitzung, Freigabe über die Chat-Karte, Denkstufe als
// Codex-Override, Workspace-MCP nur für Chat-Sitzungen.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodexChatEngine, CodingClient, CodingSessions, runTurn, type AgentDefinition, type ChatEvent, type ToolCall } from "@based/brain";
import { spawnAgent } from "@based/brain/acp-node";
import { get, startApp, TOKEN } from "./helpers.js";
import { selfHost } from "../src/main.js";

const FAKE = fileURLToPath(new URL("../../../packages/brain/test/fixtures/fake-acp-agent.mjs", import.meta.url));
const codex: AgentDefinition = { id: "codex", name: "Codex", command: process.execPath, args: [FAKE], env: {}, icon: "🅾️", enabled: true, note: "" };

const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

/** Fake `codex`: `login status` antwortet wie die echte CLI, `--version` mit einer Version. */
function fakeCodexBin(login: "chatgpt" | "apiKey" | "none" | "missing"): string {
  const bin = mkdtempSync(join(tmpdir(), "codex-bin-"));
  if (login === "missing") return bin;
  const say = login === "chatgpt" ? "echo 'Logged in using ChatGPT' >&2; exit 0" : login === "apiKey" ? "echo 'Logged in using an API key - sk-proj-***' >&2; exit 0" : "echo 'Not logged in' >&2; exit 1";
  writeFileSync(join(bin, "codex"), `#!/bin/sh\nif [ "$1" = "login" ]; then ${say}; fi\necho 'codex-cli 0.58.0'\n`);
  chmodSync(join(bin, "codex"), 0o755);
  return bin;
}

async function setup(login: "chatgpt" | "apiKey" | "none" | "missing", agents: AgentDefinition[] = [codex]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chatgpt-")));
  writeFileSync(join(root, "a.txt"), "old\n");
  const coding = new CodingSessions({
    agents: () => agents,
    roots: [root],
    chatMcpServers: () => [{ name: "based", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer x" } }],
    connect: (agent, cwd, roots, permissions) => spawnAgent(agent, { cwd, allowedRoots: roots, permissions, baseEnv: { PATH: process.env.PATH } }),
  });
  const bin = fakeCodexBin(login);
  const app = await startApp({ coding, codingLongPollMs: 2_000, codingHost: { home: mkdtempSync(join(tmpdir(), "home-")), env: { PATH: `${bin}:${process.env.PATH}` }, approvedEnv: {} } });
  apps.push(app);
  return { root, url: app.url, client: new CodingClient({ url: app.url, token: TOKEN }) };
}

async function turn(engine: CodexChatEngine, prompt: string, history: { role: "user" | "assistant"; content: string }[] = []) {
  const events: ChatEvent[] = [];
  for await (const e of runTurn(engine, { prompt, history }, new AbortController().signal)) events.push(e);
  return events;
}
const textOf = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { type: "text" }> => e.type === "text").map((e) => e.text).join("");

describe("BSD-257 ChatGPT über Codex", () => {
  it("Status: angemeldet, nicht angemeldet, API-Key, fehlt, Agent aus", async () => {
    const ok = await get(`${(await setup("chatgpt")).url}/coding/chatgpt`);
    expect(ok.body).toMatchObject({ ready: true, installed: true, login: "chatgpt", version: "codex-cli 0.58.0", agent: "codex" });
    const none = await get(`${(await setup("none")).url}/coding/chatgpt`);
    expect(none.body).toMatchObject({ ready: false, login: "none", fix: "codex login" });
    const key = await get(`${(await setup("apiKey")).url}/coding/chatgpt`);
    expect(key.body).toMatchObject({ ready: false, login: "apiKey", fix: "codex logout && codex login" });
    const missing = await get(`${(await setup("missing")).url}/coding/chatgpt`);
    expect(missing.body).toMatchObject({ ready: false, installed: false, fix: expect.stringContaining("@openai/codex") });
    const off = await get(`${(await setup("chatgpt", [{ ...codex, enabled: false }])).url}/coding/chatgpt`);
    expect(off.body).toMatchObject({ ready: false, summary: expect.stringContaining("turned off") });
    // Doctor: Codex ohne Login → needsLogin mit `codex login`
    const doc = await get(`${(await setup("none", [{ ...codex, command: "npx", args: ["-y", "@zed-industries/codex-acp"] }])).url}/coding/doctor`);
    const st = (doc.body!.agents as { id: string; state: string; fix?: string }[]).find((a) => a.id === "codex");
    if ((doc.body!.tools as { id: string; path?: string }[]).find((t) => t.id === "npx")?.path) expect(st).toMatchObject({ state: "needsLogin", fix: "codex login" });
  });

  it("Chat-Turns: Antwort, Folge-Turn in derselben Sitzung, Denkstufe, Workspace-MCP", async () => {
    const { client } = await setup("chatgpt");
    const sessions = new Map<string, string>();
    const engine = () => new CodexChatEngine({ backend: client, level: "high", sessions, key: "chat-1", policy: { mode: "askEdits" }, waitMs: 1000 });
    const first = await turn(engine(), "hello");
    expect(textOf(first)).toBe("Hi there");
    expect(first.at(-1)).toMatchObject({ type: "result" });
    expect(first.some((e) => e.type === "userMessage")).toBe(false);
    const id = sessions.get("chat-1\nhigh");
    expect(id).toBeDefined();
    expect(textOf(await turn(engine(), "args"))).toContain('model_reasoning_effort=\\"high\\"');
    expect(sessions.get("chat-1\nhigh")).toBe(id);
    expect(textOf(await turn(engine(), "mcp"))).toBe('["based"]');
    expect((await client.sessions()).length).toBe(1);
  });

  it("neue Sitzung mit Verlauf bekommt das Transkript; Einzelaufruf schließt die Sitzung", async () => {
    const { client } = await setup("chatgpt");
    const once = new CodexChatEngine({ backend: client, level: "auto", sessions: new Map(), waitMs: 1000 });
    const ev = await turn(once, "echo me", [{ role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer" }]);
    expect(textOf(ev)).toContain("earlier question");
    expect(textOf(ev)).toContain("echo me");
    expect((await client.sessions()).every((s) => s.state === "closed")).toBe(true);
  });

  it("Freigabe kommt als Chat-Karte (policy.approve), nicht über die Inbox", async () => {
    const { client, root } = await setup("chatgpt");
    const asked: ToolCall[] = [];
    const engine = new CodexChatEngine({ backend: client, level: "auto", sessions: new Map(), key: "c", waitMs: 1000,
      policy: { mode: "askEdits", approve: async (call) => { asked.push(call); return true; } } });
    const ev = await turn(engine, `edit ${root}/a.txt`);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.name).toContain("Edit");
    expect(textOf(ev)).toBe("edited");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new\n");
    expect((await client.inbox()).items).toEqual([]);

    const deny = new CodexChatEngine({ backend: client, level: "auto", sessions: new Map(), key: "d", waitMs: 1000, policy: { mode: "askEdits", approve: async () => false } });
    writeFileSync(join(root, "a.txt"), "old\n");
    expect(textOf(await turn(deny, `edit ${root}/a.txt`))).toBe("ok, not editing");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("old\n");
  });

  it("nicht angemeldet: verständlicher Fehler im Turn", async () => {
    const { client } = await setup("none");
    const ev = await turn(new CodexChatEngine({ backend: client, level: "auto", sessions: new Map(), key: "x", waitMs: 1000 }), "hello");
    expect(ev.at(-1)).toMatchObject({ type: "failed", message: expect.stringContaining("codex login") });
  });

  it("selfHost: Wildcard → Loopback, IPv6 in Klammern", () => {
    expect(selfHost("0.0.0.0")).toBe("127.0.0.1");
    expect(selfHost("::")).toBe("127.0.0.1");
    expect(selfHost("::1")).toBe("[::1]");
    expect(selfHost("192.168.1.5")).toBe("192.168.1.5");
  });
});
