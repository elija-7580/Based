// BSD-314: Terminal je Coding-Sitzung über WebSocket – Anmeldung mit der ersten Nachricht, echte Shell (node-pty) im
// Arbeitsordner der Sitzung, gefilterte Umgebung, Puffer für später Kommende, Ende mit der Sitzung.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CodingSessions, parseTerminalMessage, Terminals, type AgentDefinition, type Pty } from "@based/brain";
import { spawnAgent } from "@based/brain/acp-node";
import { loadPty } from "../src/terminal-ws.js";
import { post, startApp, TOKEN } from "./helpers.js";

const FAKE = fileURLToPath(new URL("../../../packages/brain/test/fixtures/fake-acp-agent.mjs", import.meta.url));
const fake: AgentDefinition = { id: "fake", name: "Fake Agent", command: process.execPath, args: [FAKE], env: {}, icon: "🤖", enabled: true, note: "" };
const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "term-")));
  const coding = new CodingSessions({ agents: () => [fake], roots: [root], connect: (agent, cwd, roots, permissions) => spawnAgent(agent, { cwd, allowedRoots: roots, permissions, baseEnv: { PATH: process.env.PATH } }) });
  const app = await startApp({ coding });
  apps.push(app);
  const id = (await post(`${app.url}/coding/sessions`, { agent: "fake", cwd: root })).body!.id as string;
  return { app, root, coding, id };
}

/** Verbindet, meldet sich an und sammelt Nachrichten. */
function open(url: string, id: string, token = TOKEN) {
  const ws = new WebSocket(url.replace(/^http/, "ws") + `/coding/terminal/${id}`);
  const msgs: { type: string; data?: string; code?: number; message?: string }[] = [];
  let closed: number | undefined;
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString()) as never));
  ws.on("close", (code) => { closed = code; });
  const ready = new Promise<void>((r) => ws.on("open", () => { ws.send(JSON.stringify({ type: "auth", token, cols: 100, rows: 30 })); r(); }));
  const output = () => msgs.filter((m) => m.type === "output").map((m) => m.data).join("");
  return { ws, msgs, ready, output, closed: () => closed, type: (s: string) => ws.send(JSON.stringify({ type: "input", data: s })) };
}

describe("Terminal (BSD-314)", () => {
  it("node-pty ist da (fertige Binärdatei)", () => {
    expect(loadPty()).toBeDefined();
  });

  it("Shell im Arbeitsordner, Umgebung ohne Token; zweites Gerät bekommt die bisherige Ausgabe; endet mit der Sitzung", async () => {
    process.env.BASED_TEST_SECRET_TOKEN = "s3cret";
    const { app, root, coding, id } = await setup();
    const a = open(app.url, id);
    await a.ready;
    a.type("cd . && pwd && echo \"tok=[$BASED_TEST_SECRET_TOKEN]\" && echo hi-$((40+2))\r");
    await expect.poll(a.output, { timeout: 10_000 }).toContain("hi-42");
    expect(a.output()).toContain(root);
    expect(a.output()).toContain("tok=[]");
    const b = open(app.url, id);
    await b.ready;
    await expect.poll(b.output, { timeout: 5000 }).toContain("hi-42");
    b.type("echo from-b\r");
    await expect.poll(a.output, { timeout: 5000 }).toContain("from-b");
    coding.close(id);
    await expect.poll(() => a.msgs.some((m) => m.type === "exit"), { timeout: 5000 }).toBe(true);
    a.ws.close(); b.ws.close();
    delete process.env.BASED_TEST_SECRET_TOKEN;
  });

  it("falsches Token, unbekannte Sitzung: geschlossen", async () => {
    const { app } = await setup();
    const bad = open(app.url, "cs-1", "wrong");
    await bad.ready;
    await expect.poll(bad.closed, { timeout: 5000 }).toBe(4401);
    const none = open(app.url, "nope");
    await none.ready;
    await expect.poll(none.closed, { timeout: 5000 }).toBe(4404);
    // andere Pfade bleiben zu
    const other = new WebSocket(app.url.replace(/^http/, "ws") + "/somewhere");
    await new Promise<void>((r) => { other.on("error", () => r()); other.on("close", () => r()); });
  });

  it("Nachrichten werden geprüft, Größe begrenzt; Puffer bleibt begrenzt", () => {
    expect(parseTerminalMessage("x")).toBeUndefined();
    expect(parseTerminalMessage(JSON.stringify({ type: "resize", cols: 99999, rows: -3 }))).toEqual({ type: "resize", cols: 500, rows: 2 });
    expect(parseTerminalMessage(JSON.stringify({ type: "input", data: 5 }))).toBeUndefined();
    let onData: (d: string) => void = () => {};
    const fakePty: Pty = { onData: (cb) => { onData = cb; }, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
    const t = new Terminals({ spawn: () => fakePty, baseEnv: {}, maxBuffer: 10 });
    const got: string[] = [];
    t.attach("s", "/w", { send: () => {} });
    onData("0123456789abc");
    t.attach("s", "/w", { send: (m) => { if (m.type === "output") got.push(m.data); } });
    expect(got).toEqual(["3456789abc"]);
  });
});
