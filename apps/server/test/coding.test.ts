// BSD-223 Teil 2: Coding-Agent-Sitzungen über den Server – anlegen, Prompt, Ereignisse per Long-Poll, Freigabe
// aus der Inbox von einem anderen „Gerät“, Abbruch, Agentenwechsel, Grenzen (Ordner, nur Owner). Gegen den
// Fake-ACP-Agenten aus packages/brain/test/fixtures.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CodingAPIError, CodingClient, CodingSessions, codingErrorMessage, type AgentDefinition } from "@based/brain";
import { spawnAgent } from "@based/brain/acp-node";
import { auth, get, post, startApp, TOKEN } from "./helpers.js";
import { mergeAgents, parseCodingEnv, parseOptions } from "../src/main.js";

const FAKE = fileURLToPath(new URL("../../../packages/brain/test/fixtures/fake-acp-agent.mjs", import.meta.url));
const fake: AgentDefinition = { id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE], env: {}, icon: "🤖", enabled: true, note: "" };
const off: AgentDefinition = { ...fake, id: "off", enabled: false };

const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

async function setup(host?: { home: string; env: Record<string, string | undefined>; approvedEnv: Record<string, string[]> }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coding-")));
  writeFileSync(join(root, "a.txt"), "old\n");
  const coding = new CodingSessions({
    agents: () => [fake, off],
    roots: [root],
    connect: (agent, cwd, roots, permissions) => spawnAgent(agent, { cwd, allowedRoots: roots, permissions, baseEnv: { PATH: process.env.PATH } }),
  });
  const app = await startApp({ coding, codingLongPollMs: 2_000, ...(host ? { codingHost: host } : {}) });
  apps.push(app);
  return { app, root, url: app.url };
}

async function del(url: string) {
  const r = await fetch(url, { method: "DELETE", headers: auth });
  return r.status;
}

/** Ereignisse lesen, bis der Turn endet. */
async function untilDone(url: string, id: string, since = 0) {
  const all: Record<string, unknown>[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await get(`${url}/coding/sessions/${id}/events?since=${since}&wait=1000`);
    const evs = r.body!.events as Record<string, unknown>[];
    all.push(...evs);
    since = r.body!.next as number;
    if (evs.some((e) => e.type === "result" || e.type === "failed")) return { events: all, next: since };
  }
  throw new Error("turn did not end");
}

describe("/coding", () => {
  it("Sitzung anlegen, Prompt, Ereignisse per Long-Poll", async () => {
    const { url, root } = await setup();
    expect((await get(`${url}/coding/agents`)).body).toEqual({ agents: [{ id: "fake", name: "Fake Agent", icon: "🤖", note: "" }] });
    const c = await post(`${url}/coding/sessions`, { agent: "fake", cwd: root });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ agentId: "fake", state: "idle", acpSessionId: "s1", mode: "askEdits" });
    const id = c.body!.id as string;
    // Long-Poll wartet auf den Turn.
    const waiting = get(`${url}/coding/sessions/${id}/events?since=0&wait=2000`);
    expect((await post(`${url}/coding/sessions/${id}/prompt`, { prompt: "hello" })).status).toBe(202);
    const first = await waiting;
    expect((first.body!.events as { type: string }[])[0]).toMatchObject({ type: "userMessage", text: "hello" });
    const { events } = await untilDone(url, id);
    expect(events.find((e) => e.type === "result")).toMatchObject({ text: "Hi there" });
    expect((await get(`${url}/coding/sessions`)).body!.sessions).toHaveLength(1);
    expect((await get(`${url}/coding/sessions/${id}`)).body).toMatchObject({ state: "idle" });
  });

  it("Freigabe erscheint in der Inbox und wird von einem anderen Gerät beantwortet", async () => {
    const { url, root } = await setup();
    const id = (await post(`${url}/coding/sessions`, { agent: "fake", cwd: root })).body!.id as string;
    const inbox0 = await get(`${url}/coding/inbox`);
    const version = inbox0.body!.version as number;
    expect(inbox0.body!.items).toEqual([]);
    const waiting = get(`${url}/coding/inbox?since=${version}&wait=2000`);
    await post(`${url}/coding/sessions/${id}/prompt`, { prompt: `edit ${root}/a.txt` });
    const inbox = await waiting;
    const items = inbox.body!.items as { id: string; title: string; agent: string; options: { optionId: string }[] }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: `Edit ${root}/a.txt`, agent: "Fake Agent" });
    expect((await post(`${url}/coding/inbox/${items[0]!.id}`, { optionId: "yes" })).status).toBe(200);
    expect((await post(`${url}/coding/inbox/${items[0]!.id}`, { optionId: "yes" })).status).toBe(404);
    const { events } = await untilDone(url, id);
    expect(events.find((e) => e.type === "result")).toMatchObject({ text: "edited" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new\n");
  });

  it("Modus „free“ für die Sitzung: keine Frage; „plan“: Schreiben blockiert", async () => {
    const { url, root } = await setup();
    const id = (await post(`${url}/coding/sessions`, { agent: "fake", cwd: root, mode: "free" })).body!.id as string;
    await post(`${url}/coding/sessions/${id}/prompt`, { prompt: `edit ${root}/a.txt` });
    await untilDone(url, id);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("new\n");
    writeFileSync(join(root, "a.txt"), "old\n");
    expect((await post(`${url}/coding/sessions/${id}/mode`, { mode: "plan" })).body).toMatchObject({ mode: "plan" });
    expect((await post(`${url}/coding/sessions/${id}/mode`, { mode: "nonsense" })).status).toBe(400);
    const before = (await get(`${url}/coding/sessions/${id}`)).body!.eventCount as number;
    const r = await post(`${url}/coding/sessions/${id}/prompt`, { prompt: `edit ${root}/a.txt` });
    expect(r.status).toBe(202);
    const { events } = await untilDone(url, id, before);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("old\n");
    expect(events.some((e) => e.type === "notice" && String(e.text).includes("plan mode"))).toBe(true);
  });

  it("Abbruch und Schließen; zweiter Prompt während eines Turns: 409", async () => {
    const { url, root } = await setup();
    const id = (await post(`${url}/coding/sessions`, { agent: "fake", cwd: root })).body!.id as string;
    await post(`${url}/coding/sessions/${id}/prompt`, { prompt: "wait" });
    expect((await post(`${url}/coding/sessions/${id}/prompt`, { prompt: "hello" })).status).toBe(409);
    await post(`${url}/coding/sessions/${id}/cancel`, {});
    const { events } = await untilDone(url, id);
    expect(events[events.length - 1]).toMatchObject({ type: "failed", stopped: true });
    expect(await del(`${url}/coding/sessions/${id}`)).toBe(200);
    expect((await get(`${url}/coding/sessions/${id}`)).body).toMatchObject({ state: "closed" });
    expect((await post(`${url}/coding/sessions/${id}/prompt`, { prompt: "hello" })).status).toBe(409);
  });

  it("Agentenwechsel: neue Sitzung bekommt das Transkript der alten", async () => {
    const { url, root } = await setup();
    const a = (await post(`${url}/coding/sessions`, { agent: "fake", cwd: root })).body!.id as string;
    await post(`${url}/coding/sessions/${a}/prompt`, { prompt: "hello" });
    await untilDone(url, a);
    const b = await post(`${url}/coding/sessions`, { agent: "fake", cwd: root, handoffFrom: a });
    expect(b.body).toMatchObject({ handoffFrom: a, state: "idle" });
    const id = b.body!.id as string;
    await post(`${url}/coding/sessions/${id}/prompt`, { prompt: "go on" });
    const { events } = await untilDone(url, id);
    const blocks = JSON.parse(String(events.find((e) => e.type === "result")!.text)) as { resource?: { text: string } }[];
    expect(blocks[0]!.resource!.text).toContain("## User\n\nhello");
    expect(blocks[0]!.resource!.text).toContain("Hi there");
  });

  it("Grenzen: Ordner außerhalb, unbekannter/abgeschalteter Agent, ohne Token", async () => {
    const { url, root } = await setup();
    expect((await post(`${url}/coding/sessions`, { agent: "fake", cwd: "/etc" })).status).toBe(403);
    expect((await post(`${url}/coding/sessions`, { agent: "fake", cwd: `${root}/../x` })).status).toBe(403);
    expect((await post(`${url}/coding/sessions`, { agent: "off", cwd: root })).status).toBe(400);
    expect((await post(`${url}/coding/sessions`, { agent: "fake" })).status).toBe(400);
    expect((await get(`${url}/coding/sessions`, {})).status).toBe(401);
    expect((await get(`${url}/coding/sessions/nope`)).status).toBe(404);
  });

  it("ohne --coding-root keine Routen; Optionen werden gelesen", async () => {
    const app = await startApp();
    apps.push(app);
    expect((await get(`${app.url}/coding/sessions`)).status).toBe(404);
    expect(parseOptions(["--coding-root", "/srv/code"], { BASED_CODING_ROOTS: "/a:/b" }).codingRoots).toEqual(["/a", "/b", "/srv/code"]);
    expect(() => parseOptions(["--coding-root", "rel"], {})).toThrow(/absolute/);
    expect(parseCodingEnv("claude=ANTHROPIC_API_KEY, gemini=GEMINI_API_KEY bad=1x")).toEqual({ claude: ["ANTHROPIC_API_KEY"], gemini: ["GEMINI_API_KEY"] });
    expect(parseOptions(["--coding-agents", "/x.json"], {}).codingAgents).toBe("/x.json");
    const merged = mergeAgents([fake, off], [{ id: "off", enabled: true }, { id: "mine", command: "my-acp", args: ["--acp"] }]);
    expect(merged.map((a) => [a.id, a.enabled, a.command])).toEqual([["fake", true, process.execPath], ["off", true, process.execPath], ["mine", true, "my-acp"]]);
    expect(() => mergeAgents([], [{ id: "x" }])).toThrow(/command/);
    expect(() => mergeAgents([], {})).toThrow(/array/);
  });

  it("CLI-Verlauf und Setup-Doctor (nur mit Host)", async () => {
    const home = mkdtempSync(join(tmpdir(), "home-"));
    mkdirSync(join(home, ".claude", "projects", "-p"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "-p", "c1.jsonl"), [
      JSON.stringify({ type: "user", sessionId: "c1", cwd: "/p", timestamp: "2026-11-01T10:00:00Z", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-11-01T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
    ].join("\n"));
    const bin = mkdtempSync(join(tmpdir(), "bin-"));
    writeFileSync(join(bin, "codex"), "#!/bin/sh\necho 0.1\n");
    chmodSync(join(bin, "codex"), 0o755);
    const { url } = await setup({ home, env: { PATH: `${bin}:${process.env.PATH}`, ANTHROPIC_API_KEY: "sk-x" }, approvedEnv: {} });
    const h = await get(`${url}/coding/history`);
    expect(h.body!.sessions).toMatchObject([{ tool: "claude", id: "c1", title: "hi", cwd: "/p" }]);
    const t = await get(`${url}/coding/history/claude/c1`);
    expect((t.body!.events as { type: string }[]).map((e) => e.type)).toEqual(["userMessage", "text", "result"]);
    expect((await get(`${url}/coding/history/claude/nope`)).status).toBe(404);
    // Live: ohne Änderung wartet die Anfrage und meldet „unchanged“; hängt das CLI etwas an, kommt es sofort
    const size = t.body!.size as number;
    expect(size).toBeGreaterThan(0);
    const quiet = await get(`${url}/coding/history/claude/c1?since=${size}&wait=400`);
    expect(quiet.body).toEqual({ size, unchanged: true });
    const waiting = get(`${url}/coding/history/claude/c1?since=${size}&wait=5000`);
    setTimeout(() => appendFileSync(join(home, ".claude", "projects", "-p", "c1.jsonl"), "\n" + JSON.stringify({ type: "user", timestamp: "2026-11-01T10:00:05Z", message: { role: "user", content: "more" } })), 200);
    const grown = await waiting;
    expect(grown.body!.size).toBeGreaterThan(size);
    expect((grown.body!.events as { type: string }[]).filter((e) => e.type === "userMessage")).toHaveLength(2);
    const d = await get(`${url}/coding/doctor`);
    expect((d.body!.tools as { id: string; path?: string }[]).find((x) => x.id === "codex")!.path).toBe(join(bin, "codex"));
    expect(d.body!.agents).toEqual([expect.objectContaining({ id: "fake", state: "ready" })]);
    const test = await post(`${url}/coding/doctor/fake/test`, {});
    expect(test.body).toEqual({ ok: true, message: "fake answered the ACP handshake." });
    expect((await post(`${url}/coding/doctor/nope/test`, {})).status).toBe(404);
    const plain = await setup();
    expect((await get(`${plain.url}/coding/doctor`)).status).toBe(404);
  });

  it("CodingClient spricht alle Routen (Sitzung, Long-Poll, Inbox, Modus, Schließen)", async () => {
    const { url, root } = await setup();
    const c = new CodingClient({ url: url + "/", token: TOKEN });
    expect((await c.agents()).map((a) => a.id)).toEqual(["fake"]);
    const s = await c.create({ agent: "fake", cwd: root });
    expect(s.state).toBe("idle");
    const inbox0 = await c.inbox();
    const waiting = c.inbox(inbox0.version, 2000);
    await c.prompt(s.id, `edit ${root}/a.txt`);
    const item = (await waiting).items[0]!;
    await c.answer(item.id, "yes");
    let since = 0, done = false;
    for (let i = 0; i < 20 && !done; i++) {
      const r = await c.events(s.id, since, 1000);
      since = r.next;
      done = r.events.some((e) => e.type === "result");
    }
    expect(done).toBe(true);
    expect((await c.setMode(s.id, "plan")).mode).toBe("plan");
    expect((await c.sessions()).map((x) => x.id)).toEqual([s.id]);
    await c.close(s.id);
    expect((await c.session(s.id)).state).toBe("closed");
    const failed = await c.create({ agent: "fake", cwd: "/etc" }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(CodingAPIError);
    expect(codingErrorMessage(failed)).toBe("cwd is outside the allowed folders");
    const plain = await startApp();
    apps.push(plain);
    const none = await new CodingClient({ url: plain.url, token: TOKEN }).agents().catch((e: unknown) => e);
    expect(codingErrorMessage(none)).toMatch(/--coding-root/);
    expect(codingErrorMessage(await new CodingClient({ url, token: "wrong" }).agents().catch((e: unknown) => e))).toMatch(/token/);
  });
});
