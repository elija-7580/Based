// BSD-223: Coding-Agenten über ACP – JSON-RPC-Peer, Umgebung (BSD-33), Client, Sitzung als ChatEngine,
// Freigabe-Inbox, Agentenwechsel. Gegen einen Fake-ACP-Agenten als echten Kindprozess (fixtures/fake-acp-agent.mjs).
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpEngine, ChatTurnBuilder, JsonRpcPeer, Permissions, PermissionInbox, RpcError, autoDecide, childEnvironment, diffText,
  handoffTranscript, mcpServerJSON, parseSessionUpdate, pathWithin, runTurn, secretInArguments, user, assistant,
  CodingSessions, CodingError, gitignoreMatcher, rankFiles,
  type AgentDefinition, type ChatEvent, type InboxItem,
} from "../src/index.js";
import { spawnAgent, type SpawnedAgent } from "../src/acp/stdio.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const fakeAgent: AgentDefinition = { id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE], env: {}, icon: "🤖", enabled: true, note: "" };

const running: SpawnedAgent[] = [];
afterEach(() => { for (const a of running.splice(0)) a.stop(); });

async function start(opts: Partial<Parameters<typeof spawnAgent>[1]> = {}) {
  const a = await spawnAgent(fakeAgent, { cwd: tmpdir(), baseEnv: { PATH: process.env.PATH, HOME: "/home/x" }, ...opts });
  running.push(a);
  return a;
}

async function collect(engine: AcpEngine, prompt: string, signal = new AbortController().signal, history: Parameters<typeof handoffTranscript>[0] = []) {
  const events: ChatEvent[] = [];
  for await (const e of runTurn(engine, { prompt, history }, signal)) events.push(e);
  return events;
}

describe("JsonRpcPeer", () => {
  function pair() {
    const peers: { a?: JsonRpcPeer; b?: JsonRpcPeer } = {};
    const a = new JsonRpcPeer((l) => queueMicrotask(() => peers.b!.receive(l)));
    const b = new JsonRpcPeer((l) => queueMicrotask(() => a.receive(l)));
    peers.b = b;
    return { a, b };
  }

  it("Anfrage/Antwort in beide Richtungen, Fehler mit Code, Zeilen in Stücken", async () => {
    const { a, b } = pair();
    b.onRequest = async (m, p) => { if (m === "add") return (p as number[])[0]! + (p as number[])[1]!; throw RpcError.methodNotFound(m); };
    expect(await a.request("add", [2, 3])).toBe(5);
    await expect(a.request("nope")).rejects.toMatchObject({ code: -32601 });
    const seen: string[] = [];
    a.onNotification = (m) => seen.push(m);
    a.receive('{"jsonrpc":"2.0","met');
    a.receive('hod":"ping"}\n\n{"broken\n');
    expect(seen).toEqual(["ping"]);
  });

  it("geschlossene Verbindung: offene Anfragen schlagen fehl statt zu hängen", async () => {
    const a = new JsonRpcPeer(() => {});
    const p = a.request("x");
    a.close();
    await expect(p).rejects.toMatchObject({ code: -32000 });
    await expect(a.request("y")).rejects.toThrow("Connection closed");
  });

  it("Schreibfehler schließt die Verbindung", async () => {
    const a = new JsonRpcPeer(() => { throw new Error("EPIPE"); });
    await expect(a.request("x")).rejects.toThrow("Connection closed");
    expect(a.closed).toBe(true);
  });
});

describe("Umgebung und Argumente (BSD-33)", () => {
  it("nur Allowlist; Geheimnisse nur, wenn für den Agenten freigegeben", () => {
    const base = { PATH: "/bin", HOME: "/h", LC_ALL: "de", ANTHROPIC_API_KEY: "sk-1", GITHUB_TOKEN: "t", BASED_SECRET: "x", RANDOM: "r", CLAUDE_CONFIG_DIR: "/c" };
    expect(childEnvironment(base)).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "de" });
    expect(childEnvironment(base, { agentId: "claude", approved: ["ANTHROPIC_API_KEY"] })).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "de", ANTHROPIC_API_KEY: "sk-1", CLAUDE_CONFIG_DIR: "/c" });
    expect(childEnvironment(base, { extra: { FOO: "1", "bad name": "x" } }).FOO).toBe("1");
  });

  it("Token auf der Kommandozeile wird erkannt", () => {
    expect(secretInArguments(["-y", "@zed-industries/claude-code-acp"])).toBeUndefined();
    expect(secretInArguments(["--api-key=abc"])).toBe("--api-key=…");
    expect(secretInArguments(["sk-ant-abcdefghijk"])).toBe("sk-a…");
  });

  it("Kindprozess sieht nur gefilterte Variablen", async () => {
    const a = await start({ baseEnv: { PATH: process.env.PATH, HOME: "/h", OPENAI_API_KEY: "sk-x", SECRET_THING: "y" } });
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: tmpdir(), inbox: new PermissionInbox() });
    const ev = await collect(engine, "env");
    const names = (ev.find((e) => e.type === "result") as { text: string }).text.split(",");
    expect(names).toContain("HOME");
    expect(names).not.toContain("OPENAI_API_KEY");
    expect(names).not.toContain("SECRET_THING");
  });

  it("Start mit Geheimnis-Argument wird abgelehnt", async () => {
    await expect(spawnAgent({ ...fakeAgent, args: [FAKE, "--token=abc"] }, { cwd: tmpdir() })).rejects.toThrow(/command line/);
  });

  it("fehlende CLI: verständlicher Fehler", async () => {
    await expect(spawnAgent({ ...fakeAgent, command: "/nonexistent/acp-agent" }, { cwd: tmpdir() })).rejects.toThrow(/could not be started/);
  });
});

describe("Pfade, Updates, Diffs", () => {
  it("pathWithin abschnittsweise", () => {
    expect(pathWithin("/p/proj", "/p/proj/a.txt")).toBe(true);
    expect(pathWithin("/p/proj", "/p/proj-secret/a")).toBe(false);
    expect(pathWithin("/p/proj", "/p/proj/../other")).toBe(false);
    expect(pathWithin("/p/proj", "relative")).toBe(false);
  });

  it("session/update wird gelesen, Unbekanntes bleibt `other`", () => {
    expect(parseSessionUpdate({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } })).toEqual({ type: "agentText", text: "x" });
    expect(parseSessionUpdate({ update: { sessionUpdate: "tool_call", toolCallId: "t", title: "Run", kind: "execute", rawInput: { command: ["npm", "test"] } } }))
      .toMatchObject({ type: "toolCall", id: "t", input: { kind: "execute", path: "npm test" } });
    expect(parseSessionUpdate({ update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "init", description: "Init" }] } }))
      .toEqual({ type: "commands", commands: [{ name: "init", description: "Init" }] });
    expect(parseSessionUpdate({ update: { sessionUpdate: "future_thing" } })).toEqual({ type: "other", kind: "future_thing" });
    expect(parseSessionUpdate({})).toBeUndefined();
  });

  it("Diff-Text zeigt nur geänderte Zeilen", () => {
    expect(diffText({ path: "a", oldText: "1\n2\n3", newText: "1\nX\n3" })).toBe("--- a\n+++ a\n@@ -2,1 +2,1 @@\n-2\n+X");
  });

  it("MCP-Server in ACP-Form", () => {
    expect(mcpServerJSON({ name: "based", url: "http://x/mcp", headers: { Authorization: "Bearer t" } }))
      .toEqual({ type: "http", name: "based", url: "http://x/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] });
    expect(mcpServerJSON({ name: "fs", command: "npx", env: { B: "2", A: "1" } })).toEqual({ name: "fs", command: "npx", args: [], env: [{ name: "A", value: "1" }, { name: "B", value: "2" }] });
  });
});

describe("Sitzung als ChatEngine", () => {
  it("Text, Thinking, Verbrauch → ChatEvents; Turn endet mit result und Sitzungs-ID", async () => {
    const a = await start();
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: "/work", mcpServers: [{ name: "based", url: "http://x" }], inbox: new PermissionInbox() });
    const ev = await collect(engine, "hello");
    expect(ev[0]).toMatchObject({ type: "started", model: "Fake Agent", sessionID: "s1" });
    expect(ev.filter((e) => e.type === "textDelta").map((e) => (e as { text: string }).text)).toEqual(["Hi ", "there"]);
    expect(ev.some((e) => e.type === "thinkingDelta")).toBe(true);
    expect(ev.find((e) => e.type === "usage")).toMatchObject({ inputTokens: 12, outputTokens: 3, estimated: true });
    expect(ev[ev.length - 1]).toMatchObject({ type: "result", text: "Hi there", sessionID: "s1", isError: false });
    expect(a.client.availableModes.map((m) => m.id)).toEqual(["default", "acceptEdits", "plan"]);
    const b = new ChatTurnBuilder();
    for (const e of ev) b.apply(e);
    expect(b.parts.filter((p) => p.kind === "text").map((p) => p.text)).toEqual(["Hi there"]);
    // Zweiter Turn: dieselbe Sitzung.
    const ev2 = await collect(engine, "hello");
    expect(ev2[0]).toMatchObject({ sessionID: "s1" });
  });

  it("Modus setzen meldet den neuen Modus", async () => {
    const a = await start();
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: "/w", inbox: new PermissionInbox() });
    await engine.ensureSession();
    await a.client.setMode("plan");
    expect(a.client.currentMode).toBe("plan");
  });

  it("Plan des Agenten als Tool-Eintrag", async () => {
    const a = await start();
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: "/w", inbox: new PermissionInbox() });
    const ev = await collect(engine, "plan");
    expect(ev.find((e) => e.type === "toolResult")).toMatchObject({ output: "[x] Look\n[ ] Fix" });
  });

  it("Abbruch: session/cancel, Turn endet als gestoppt", async () => {
    const a = await start();
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: "/w", inbox: new PermissionInbox() });
    const ctl = new AbortController();
    const p = collect(engine, "wait", ctl.signal);
    setTimeout(() => ctl.abort(), 100);
    const ev = await p;
    expect(ev[ev.length - 1]).toMatchObject({ type: "failed", stopped: true });
    // Die Sitzung lebt weiter.
    expect((await collect(engine, "hello")).pop()).toMatchObject({ type: "result", text: "Hi there" });
  });
});

describe("Freigabe-Inbox", () => {
  function setup() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-")));
    writeFileSync(join(dir, "a.txt"), "old\n");
    return dir;
  }

  it("Freigabe erscheint in der Inbox und wirkt (Datei wird geschrieben, Diff im Ergebnis)", async () => {
    const dir = setup();
    const a = await start({ allowedRoots: [dir] });
    const inbox = new PermissionInbox();
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: dir, inbox });
    const seen: InboxItem[][] = [];
    inbox.subscribe((items) => {
      seen.push([...items]);
      const it = items[0];
      if (it) setTimeout(() => inbox.resolveKind(it.id, "allow_once"), 10);
    });
    const ev = await collect(engine, `edit ${dir}/a.txt`);
    expect(seen.some((s) => s.length === 1 && s[0]!.title === `Edit ${dir}/a.txt` && s[0]!.agent === "Fake Agent" && s[0]!.argument === `${dir}/a.txt`)).toBe(true);
    expect(inbox.pending()).toEqual([]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("new\n");
    expect(ev.find((e) => e.type === "permissionRequest")).toMatchObject({ id: "t1" });
    const result = ev.find((e) => e.type === "toolResult") as { output: string; isError: boolean };
    expect(result.isError).toBe(false);
    expect(result.output).toContain("-old\n+new");
    const tool = [...ev].reverse().find((e) => e.type === "toolUse") as unknown as { input: { diffs: unknown[] } };
    expect(tool.input.diffs).toHaveLength(1);
  });

  it("Ablehnen aus der Inbox: nichts geschrieben", async () => {
    const dir = setup();
    const a = await start({ allowedRoots: [dir] });
    const inbox = new PermissionInbox();
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: dir, inbox });
    inbox.subscribe((items) => { const it = items[0]; if (it) queueMicrotask(() => inbox.resolve(it.id, "no")); });
    const ev = await collect(engine, `edit ${dir}/a.txt`);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("old\n");
    expect(ev.find((e) => e.type === "toolResult")).toMatchObject({ isError: true, output: "rejected" });
  });

  it("Regeln entscheiden ohne Rückfrage: free erlaubt, deny lehnt ab", async () => {
    const dir = setup();
    const a = await start({ allowedRoots: [dir] });
    const inbox = new PermissionInbox();
    let asked = 0;
    inbox.subscribe((items) => { asked += items.length; });
    const free = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: dir, inbox, permissions: new Permissions("free") });
    await collect(free, `edit ${dir}/a.txt`);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("new\n");
    writeFileSync(join(dir, "a.txt"), "old\n");
    const b = await start({ allowedRoots: [dir] });
    const denied = new AcpEngine({ agent: fakeAgent, connect: async () => b.client, cwd: dir, inbox, permissions: Permissions.from("deny Edit(*a.txt)", "free") });
    const ev = await collect(denied, `edit ${dir}/a.txt`);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("old\n");
    expect(ev.some((e) => e.type === "notice" && e.text.includes("deny Edit"))).toBe(true);
    expect(asked).toBe(0);
  });

  it("autoDecide: Lesen ist ohne Frage erlaubt, ask-Modus fragt, „allow“ ohne passende Option fragt", () => {
    const req = { sessionId: "s", toolCallId: "t", title: "Read", kind: "read", argument: "/a", detail: "", options: [{ optionId: "y", name: "Y", kind: "allow_once" }] };
    expect(autoDecide(req, new Permissions("askEdits"))).toMatchObject({ effect: "allow", optionId: "y" });
    expect(autoDecide({ ...req, kind: "execute" }, new Permissions("askEdits")).effect).toBe("ask");
    expect(autoDecide({ ...req, kind: "execute", argument: "npm test" }, Permissions.from("allow Bash(npm *)"))).toMatchObject({ effect: "allow" });
    expect(autoDecide({ ...req, options: [] }, new Permissions("free")).effect).toBe("ask");
  });

  it("Stopp räumt offene Fragen der Sitzung ab", async () => {
    const dir = setup();
    const a = await start({ allowedRoots: [dir] });
    const inbox = new PermissionInbox();
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: dir, inbox });
    const ctl = new AbortController();
    inbox.subscribe((items) => { if (items.length > 0) setTimeout(() => ctl.abort(), 10); });
    const ev = await collect(engine, `edit ${dir}/a.txt`, ctl.signal);
    expect(ev[ev.length - 1]).toMatchObject({ type: "failed", stopped: true });
    expect(inbox.pending()).toEqual([]);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("old\n");
  });

  it("unbekannte Option zählt als Abbruch", async () => {
    const inbox = new PermissionInbox();
    const p = inbox.ask("A", { sessionId: "s", toolCallId: "t", title: "x", kind: "edit", argument: undefined, detail: "", options: [{ optionId: "y", name: "Y", kind: "allow_once" }] });
    expect(inbox.resolve(inbox.pending()[0]!.id, "made-up")).toBe(true);
    expect(await p).toBeUndefined();
    expect(inbox.resolve("perm-404", "y")).toBe(false);
  });
});

describe("Dateizugriff des Agenten", () => {
  it("außerhalb der erlaubten Ordner und über Symlinks nach außen: verweigert", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-")));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "acp-out-")));
    writeFileSync(join(outside, "secret.txt"), "s3cret");
    mkdirSync(join(dir, "proj"));
    writeFileSync(join(dir, "proj", "ok.txt"), "fine");
    symlinkSync(outside, join(dir, "proj", "link"));
    const a = await start({ allowedRoots: [join(dir, "proj")] });
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: dir, inbox: new PermissionInbox() });
    expect((await collect(engine, `read ${dir}/proj/ok.txt`)).pop()).toMatchObject({ text: "content: fine" });
    expect((await collect(engine, `read ${outside}/secret.txt`)).pop()).toMatchObject({ text: "read failed: Read not permitted" });
    expect((await collect(engine, `read ${dir}/proj/link/secret.txt`)).pop()).toMatchObject({ text: "read failed: Read not permitted" });
    expect((await collect(engine, `read ${dir}/proj/../proj-x`)).pop()).toMatchObject({ text: "read failed: Read not permitted" });
  });

  it("Plan-Modus blockiert fs/write auch nach Freigabe", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-")));
    writeFileSync(join(dir, "a.txt"), "old\n");
    const a = await start({ allowedRoots: [dir], permissions: new Permissions("plan") });
    const inbox = new PermissionInbox();
    inbox.subscribe((items) => { const it = items[0]; if (it) queueMicrotask(() => inbox.resolveKind(it.id, "allow_once")); });
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: dir, inbox });
    const ev = await collect(engine, `edit ${dir}/a.txt`);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("old\n");
    expect((ev.pop() as { text: string }).text).toMatch(/write failed: Write not permitted by the permission rules/);
  });
});

describe("Agentenwechsel und Fortsetzen", () => {
  it("neue Sitzung mit Verlauf bekommt das Transkript beim ersten Prompt, danach nicht mehr", async () => {
    const history = [user("fix the bug"), assistant("Looked at main.ts")];
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => (await start()).client, cwd: "/w", inbox: new PermissionInbox(), handoffFrom: "Codex" });
    const ev = await collect(engine, "continue", undefined, history);
    const blocks = JSON.parse((ev.pop() as { text: string }).text) as { type: string; resource?: { uri: string; text: string } }[];
    expect(blocks[0]!.resource!.uri).toBe("based://handoff/transcript.md");
    expect(blocks[0]!.resource!.text).toContain("(with Codex)");
    expect(blocks[0]!.resource!.text).toContain("fix the bug");
    expect(blocks[1]).toEqual({ type: "text", text: "continue" });
    const evMore = await collect(engine, "more", undefined, history);
    expect(JSON.parse((evMore.pop() as { text: string }).text)).toHaveLength(1);
  });

  it("Fortsetzen lädt die Sitzung (session/load) ohne Übergabe-Transkript", async () => {
    const a = await start();
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: "/w", inbox: new PermissionInbox(), resumeSessionId: "old-7" });
    const ev = await collect(engine, "x", undefined, [user("earlier")]);
    expect(ev[0]).toMatchObject({ sessionID: "old-7" });
    expect(JSON.parse((ev.pop() as { text: string }).text)).toHaveLength(1);
  });

  it("handoffTranscript kürzt Tool-Ausgaben und lässt System weg", () => {
    const t = handoffTranscript([{ role: "system", content: "SYS" }, user("hi"), { role: "tool", content: "x".repeat(2000), toolCallID: "c" }]);
    expect(t).not.toContain("SYS");
    expect(t).toContain("## User");
    expect(t).toContain("x".repeat(1500) + "…");
  });
});

describe("Slash-Befehle, @Dateien, Modi (BSD-313)", () => {
  it("available_commands_update wird gelesen (mit hint) und gemerkt, auch außerhalb eines Turns", async () => {
    expect(parseSessionUpdate({ update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "a", description: "x", input: { hint: "h" } }, { description: "ohne Namen" }] } }))
      .toEqual({ type: "commands", commands: [{ name: "a", description: "x", hint: "h" }] });
    const a = await start();
    let changes = 0;
    a.client.onStateChange = () => { changes++; };
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: "/w", inbox: new PermissionInbox() });
    await engine.ensureSession();
    await expect.poll(() => a.client.availableCommands.map((c) => c.name)).toEqual(["review", "init", "compact"]);
    expect(a.client.availableCommands[2]).toEqual({ name: "compact", description: "Summarize the conversation", hint: "what to keep" });
    expect(changes).toBeGreaterThanOrEqual(1);
    await a.client.setMode("acceptEdits");
    expect(a.client.currentMode).toBe("acceptEdits");
  });

  it("@Dateien gehen als resource_link hinter dem Text an den Agenten", async () => {
    const a = await start();
    const engine = new AcpEngine({ agent: fakeAgent, connect: async () => a.client, cwd: "/w", inbox: new PermissionInbox() });
    const ev: ChatEvent[] = [];
    for await (const e of runTurn(engine, { prompt: "look", files: [{ uri: "file:///w/src/a.ts", name: "src/a.ts" }] }, new AbortController().signal)) ev.push(e);
    const echoed = JSON.parse((ev.find((e) => e.type === "result") as { text: string }).text) as unknown[];
    expect(echoed).toEqual([{ type: "text", text: "look" }, { type: "resource_link", uri: "file:///w/src/a.ts", name: "src/a.ts" }]);
  });

  it("Sitzungen: Befehle und Agent-Modus in der Ansicht, ⇧Tab-Wechsel, Dateien nur unterhalb des Ordners", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acp-313-")));
    const coding = new CodingSessions({ agents: () => [fakeAgent], roots: [root], connect: (agent, cwd, roots, permissions) => start({ cwd, allowedRoots: roots, permissions }) });
    const v = await coding.create({ agentId: "fake", cwd: root });
    expect(v).toMatchObject({ state: "idle", agentMode: "default", modes: [{ id: "default" }, { id: "acceptEdits" }, { id: "plan" }] });
    // Long-Poll wacht auf, wenn die Befehle kommen (ohne neues Ereignis).
    const r = await coding.events(v.id, 0, 2000);
    const commands = r.session.commands.length > 0 ? r.session.commands : (await coding.events(v.id, 0, 2000)).session.commands;
    expect(commands.map((c) => c.name)).toEqual(["review", "init", "compact"]);
    expect((await coding.setAgentMode(v.id, "plan")).agentMode).toBe("plan");
    await expect(coding.setAgentMode(v.id, "nope")).rejects.toThrow(CodingError);
    for (const bad of ["../x", "/etc/passwd", "a/../../x", ""]) expect(() => coding.prompt(v.id, "x", [bad])).toThrow(/outside the session folder/);
    coding.prompt(v.id, "see", ["./src/a b.ts"]);
    const all: { type: string }[] = [];
    for (let i = 0, next = 0; i < 50 && !all.some((e) => e.type === "result"); i++) {
      const r2 = await coding.events(v.id, next, 500);
      all.push(...r2.events);
      next = r2.next;
    }
    expect(all[0]).toMatchObject({ type: "userMessage", text: "see\n\n@src/a b.ts" });
    const res = all.find((e) => e.type === "result") as unknown as { text: string };
    expect(JSON.parse(res.text)).toContainEqual({ type: "resource_link", uri: `file://${root.split("/").map(encodeURIComponent).join("/")}/src/a%20b.ts`, name: "src/a b.ts" });
    coding.closeAll();
  });

  it("rankFiles: Dateiname vor Pfad, fuzzy, kürzere Pfade zuerst; 50.000 Dateien schnell", () => {
    const paths = ["src/main.ts", "src/deep/x/main.test.ts", "README.md", "docs/maintenance.md", "lib/remain.ts", "src/domain/a.ts"];
    expect(rankFiles(paths, "main").map((f) => f.path)).toEqual(["src/main.ts", "docs/maintenance.md", "src/deep/x/main.test.ts", "lib/remain.ts", "src/domain/a.ts"]);
    expect(rankFiles(paths, "src/ma").map((f) => f.path)).toEqual(["src/main.ts", "src/domain/a.ts", "src/deep/x/main.test.ts"]);
    expect(rankFiles(paths, "rdm").map((f) => f.name)).toEqual(["README.md"]);
    expect(rankFiles(paths, "", 2).map((f) => f.path)).toEqual(["README.md", "src/main.ts"]);
    const many = Array.from({ length: 50_000 }, (_, i) => `pkg${i % 50}/src/dir${i % 7}/file${i}.ts`);
    const t = performance.now();
    expect(rankFiles(many, "file4242").length).toBeGreaterThan(0);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it("gitignoreMatcher (Fallback ohne git)", () => {
    const m = gitignoreMatcher("# c\ndist/\n*.log\n/secret.txt\nbuild/**/out\n!keep.log\n");
    expect(m("dist", true)).toBe(true);
    expect(m("a/dist", true)).toBe(true);
    expect(m("dist", false)).toBe(false);
    expect(m("x/y.log", false)).toBe(true);
    expect(m("secret.txt", false)).toBe(true);
    expect(m("sub/secret.txt", false)).toBe(false);
    expect(m("build/a/b/out", true)).toBe(true);
    expect(m("src/a.ts", false)).toBe(false);
  });
});
