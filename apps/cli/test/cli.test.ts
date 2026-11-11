// `based` gegen einen In-Process-Server (MCP über Streamable HTTP), Argumente, Konfiguration, `ask --wait`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, localPaths, removeLocalDiscovery, silentLogger, writeLocalDiscovery, type App } from "@based/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";
import { BasedCLI, runSnapshot, shellCommand, type MCPSession } from "../src/cli.js";
import { configFileContents, configPath, localConfig, resolveConfig } from "../src/config.js";
import { connect, main } from "../src/main.js";

const TOKEN = "cli-test-token-0123456789";
let app: App;
let url: string;

beforeAll(async () => {
  app = createApp({ token: TOKEN, log: silentLogger, compactEvery: false });
  url = (await app.listen(0, "127.0.0.1")).url;
});
afterAll(() => app.close());

async function run(argv: string[], env: Record<string, string | undefined> = { BASED_URL: url, BASED_TOKEN: TOKEN }, home = "/nonexistent") {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { env, home, out: (s) => out.push(s), err: (s) => err.push(s), stdin: async () => "" });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("Argumente", () => {
  it("lehnt Geheimnisse auf der Kommandozeile ab", () => {
    expect(() => parseArgs(["search", "x", "--token", "abc"])).toThrow(/shell history/);
    expect(() => parseArgs(["search", "x", "--token=abc"])).toThrow(/shell history/);
  });
  it("Befehle und Fehler", () => {
    expect(parseArgs(["ask", "Summarise", "today", "--wait", "--timeout", "60"]).command).toEqual({ name: "ask", task: "Summarise today", wait: true, timeout: 60 });
    expect(parseArgs(["runs", "--running", "--limit=5"]).command).toEqual({ name: "runs", status: "Running", limit: 5 });
    expect(parseArgs(["page", "new", "--title", "Notes", "--parent", "P"]).command).toEqual({ name: "pageNew", title: "Notes", parent: "P" });
    expect(() => parseArgs(["ask", "x", "--timeout", "5"])).toThrow("--timeout only applies with --wait");
    expect(() => parseArgs(["runs", "--status", "Weird"])).toThrow("--status must be one of");
    expect(() => parseArgs(["search", "x", "--title", "y"])).toThrow("--title does not apply to `search`");
    expect(parseArgs([]).command).toEqual({ name: "help" });
  });
});

describe("Konfiguration", () => {
  const io = (files: Record<string, string>, env: Record<string, string> = {}, modes: Record<string, number> = {}) => ({ env, home: "/h", readFile: (p: string) => files[p], fileMode: (p: string) => modes[p] });
  it("Reihenfolge und Herkunft; https außer localhost; offene Dateien abgelehnt", () => {
    const cfg = { "/h/.config/based/config.json": JSON.stringify({ url: "https://based.example.com", token: "file-token" }) };
    expect(resolveConfig({ json: false }, io(cfg))).toEqual({ url: "https://based.example.com", token: "file-token", tokenSource: "/h/.config/based/config.json" });
    expect(resolveConfig({ json: false }, io(cfg, { BASED_TOKEN: "env" })).tokenSource).toBe("BASED_TOKEN");
    expect(() => resolveConfig({ json: false, url: "http://based.example.com" }, io(cfg))).toThrow("https://");
    expect(() => resolveConfig({ json: false }, io(cfg, {}, { "/h/.config/based/config.json": 0o644 }))).toThrow("readable by others");
    expect(() => resolveConfig({ json: false }, io({}))).toThrow("No server configured");
  });
});

describe("BSD-138: lokaler Server der Desktop-App", () => {
  const disc = (d: object) => JSON.stringify({ v: 1, pid: 42, tokenFile: "/h/.config/based/local-token", ...d });
  const io = (files: Record<string, string>, opts: { env?: Record<string, string>; modes?: Record<string, number>; alive?: boolean } = {}) =>
    ({ env: opts.env ?? {}, home: "/h", readFile: (p: string) => files[p], fileMode: (p: string) => opts.modes?.[p], alive: () => opts.alive ?? true });
  const local = { "/h/.config/based/local.json": disc({ url: "http://127.0.0.1:5123" }), "/h/.config/based/local-token": "tok\n" };

  it("Fallback ohne eingestellten Server, --local erzwingt, eingestellter Server gewinnt sonst", () => {
    expect(resolveConfig({ json: false }, io(local))).toEqual({ url: "http://127.0.0.1:5123", token: "tok", tokenSource: "desktop app (/h/.config/based/local-token)" });
    const cfg = { ...local, "/h/.config/based/config.json": JSON.stringify({ url: "https://based.example.com", token: "file-token" }) };
    expect(resolveConfig({ json: false }, io(cfg)).url).toBe("https://based.example.com");
    expect(resolveConfig({ json: false, local: true }, io(cfg)).url).toBe("http://127.0.0.1:5123");
    expect(resolveConfig({ json: false }, io(local, { env: { BASED_URL: "https://x.example" , BASED_TOKEN: "t" } })).url).toBe("https://x.example");
  });

  it("beendete App, fremde Adresse, offene Token-Datei, fehlende Dateien", () => {
    expect(localConfig(io(local, { alive: false }))).toBeUndefined();
    expect(() => resolveConfig({ json: false }, io(local, { alive: false }))).toThrow("Open the Based desktop app");
    expect(() => resolveConfig({ json: false, local: true }, io({}))).toThrow("isn't running");
    expect(() => localConfig(io({ ...local, "/h/.config/based/local.json": disc({ url: "http://evil.example:80" }) }))).toThrow("outside this computer");
    expect(() => localConfig(io({ ...local, "/h/.config/based/local.json": disc({ url: "https://127.0.0.1:1" }) }))).toThrow("outside this computer");
    expect(() => localConfig(io(local, { modes: { "/h/.config/based/local-token": 0o644 } }))).toThrow("readable by others");
    expect(localConfig(io({ "/h/.config/based/local.json": "{" }))).toBeUndefined();
    expect(localConfig(io({ "/h/.config/based/local.json": disc({ url: "http://127.0.0.1:1" }) }))).toBeUndefined();
  });

  it("--local mit --url wird abgelehnt", () => {
    expect(() => parseArgs(["--local", "--url", "http://127.0.0.1:1", "tools"])).toThrow("--local");
    expect(parseArgs(["--local", "tools"]).options.local).toBe(true);
  });

  it("echte Dateien: Server schreibt Discovery (0600, ohne Token), CLI findet ihn, Aufräumen nur durch den Besitzer", async () => {
    const home = mkdtempSync(join(tmpdir(), "based-local-"));
    try {
      const port = Number(new URL(url).port);
      const d = writeLocalDiscovery(home, { port, token: TOKEN, owner: "test" });
      const p = localPaths(home);
      expect(statSync(p.discovery).mode & 0o777).toBe(0o600);
      expect(statSync(p.token).mode & 0o777).toBe(0o600);
      expect(readFileSync(p.discovery, "utf8")).not.toContain(TOKEN);
      expect(d.url).toBe(`http://127.0.0.1:${port}`);
      const cfg = await run(["config"], {}, home);
      expect(cfg.out).toBe(`Server: ${d.url}\nToken:  from desktop app (${p.token})`);
      expect((await run(["tools"], {}, home)).code).toBe(0);
      expect((await run(["--local", "tools"], { BASED_URL: "https://elsewhere.example" }, home)).code).toBe(0);
      expect(removeLocalDiscovery(home, d.pid + 1)).toBe(false);
      expect(removeLocalDiscovery(home, d.pid)).toBe(true);
      expect((await run(["tools"], {}, home)).err).toContain("No server configured");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("gegen den Server (MCP)", () => {
  it("page new (stdin), page get per Titel, page list, search, tools, --json", async () => {
    const parent = app.pages.create({ title: "Projects" });
    // stdin direkt an BasedCLI (main liest process.stdin), sonst derselbe Weg
    const lines: string[] = [];
    const s = await connect(url, TOKEN);
    await new BasedCLI(s, { out: (l) => lines.push(l), stdin: () => "Hello from the **CLI**\n" }).execute({ name: "pageNew", title: "CLI Notes", parent });
    await s.close();
    expect(lines.join("\n")).toMatch(/^Created CLI Notes \(id: [0-9A-F-]{36}/);
    const got = await run(["page", "get", "CLI Notes"]);
    expect(got.code).toBe(0);
    expect(got.out).toBe("# CLI Notes\n\nHello from the **CLI**\n");
    const list = await run(["page", "list", "--parent", parent]);
    expect(list.out).toMatch(/^- CLI Notes \(id: /);
    const search = await run(["search", "Hello"]);
    expect(search.out).toContain("CLI Notes");
    const tools = await run(["tools"]);
    expect(tools.out).toContain("read_page — ");
    const json = await run(["search", "Hello", "--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ content: [{ type: "text" }] });
  });

  it("was der Server nicht anbietet (ask), sagt der Befehl ehrlich", async () => {
    const r = await run(["ask", "Do it"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/This server doesn't offer .* \(no `ask_main_agent` tool\)/);
  });

  it("BSD-221 Teil 3a: runs, run, inbox gegen den TS-Server", async () => {
    expect(await run(["runs"])).toMatchObject({ code: 0, out: "No runs yet." });
    expect(await run(["inbox"])).toMatchObject({ code: 0, out: "Nothing needs you right now." });
    const shell = await run(["sandbox", "shell", "r1"]);
    expect(shell.code).toBe(1);
    expect(shell.err).toContain("No run with id r1");
  });

  it("falscher Token: verständliche Meldung, Exit 1; Token nie in der Ausgabe", async () => {
    const r = await run(["search", "x"], { BASED_URL: url, BASED_TOKEN: "wrong-token-123" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Not authorised");
    expect(r.err + r.out).not.toContain("wrong-token-123");
  });

  it("login ohne Token auf stdin scheitert; config zeigt nur die Herkunft des Tokens", async () => {
    const home = mkdtempSync(join(tmpdir(), "based-cli-"));
    try {
      const empty = await run(["login", "--url", url], {}, home);
      expect(empty.code).toBe(1);
      expect(empty.err).toContain("no token on stdin");
      mkdirSync(join(home, ".config/based"), { recursive: true });
      writeFileSync(configPath(home), configFileContents(url, TOKEN), { mode: 0o600 });
      const cfg = await run(["config"], {}, home);
      expect(cfg.out).toBe(`Server: ${url}\nToken:  from ${configPath(home)}`);
      expect(cfg.out).not.toContain(TOKEN);
      expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(configPath(home), "utf8")).url).toBe(url);
      expect((await run(["search", "Hello"], {}, home)).code).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("ask --wait und Sandbox-Shell (Server mit Läufen, gemockt)", () => {
  const fakeServer = (states: string[]): MCPSession => {
    let i = 0;
    return {
      listTools: async () => ["ask_main_agent", "get_run"].map((name) => ({ name, inputSchema: { properties: name === "get_run" ? { run_id: {} } : { task: {} } } })),
      callTool: async (name, args) => {
        if (name === "ask_main_agent") return { content: [{ type: "text", text: "Handed to the main agent: run 11111111-2222-4333-8444-555555555555" }] };
        expect(args).toEqual({ run_id: "11111111-2222-4333-8444-555555555555" });
        const s = states[Math.min(i++, states.length - 1)]!;
        return { content: [{ type: "text", text: s }] };
      },
    };
  };
  it("folgt dem Lauf bis zum Ende", async () => {
    const lines: string[] = [];
    await new BasedCLI(fakeServer(["- [Running] Task\n\nResult:\nstep 1", "- [Running] Task\n\nResult:\nstep 1\nstep 2", "- [Done] Task\n\nResult:\nAll done"]), { out: (l) => lines.push(l), sleep: async () => {} })
      .execute({ name: "ask", task: "x", wait: true });
    expect(lines).toEqual(["Run 11111111-2222-4333-8444-555555555555 started — waiting for the result (Ctrl-C stops waiting, the run keeps going).", "· Running", "  step 1", "  step 2", "All done"]);
  });
  it("Fehlschlag → Fehler; Zeitlimit → Hinweis", async () => {
    await expect(new BasedCLI(fakeServer(["- [Failed] T\n\nResult:\nboom"]), { out: () => {}, sleep: async () => {} }).execute({ name: "ask", task: "x", wait: true })).rejects.toThrow("failed");
    await expect(new BasedCLI(fakeServer(["- [Running] T"]), { out: () => {}, sleep: async () => {}, pollMs: 1000 }).execute({ name: "ask", task: "x", wait: true, timeout: 2 })).rejects.toThrow("Still Running after 2 s");
  });
  it("runSnapshot und shellCommand", () => {
    expect(runSnapshot("- [Needs you] X\n\nResult:\nwaiting\n\nProtocol:\n…")).toEqual({ status: "Needs you", result: "waiting" });
    expect(shellCommand("docker:abc123", "r")).toBe("docker exec -it abc123 /bin/sh");
    expect(() => shellCommand("docker:a;rm -rf /", "r")).toThrow("no usable container");
    expect(shellCommand("local:/srv/ws/p", "r")).toBe('cd /srv/ws/p && exec "${SHELL:-/bin/sh}"');
  });
});

describe("BSD-319: based reports", () => {
  it("listet Berichte aus ~/.config/based/reports ohne Server, neueste zuerst, überspringt Fremdes", async () => {
    const home = mkdtempSync(join(tmpdir(), "based-reports-"));
    try {
      const dir = join(home, ".config", "based", "reports");
      const put = (id: string, body: unknown, shot = false) => {
        mkdirSync(join(dir, id), { recursive: true });
        writeFileSync(join(dir, id, "report.json"), typeof body === "string" ? body : JSON.stringify(body));
        if (shot) writeFileSync(join(dir, id, "screenshot.png"), "png");
      };
      put("20261111-170000-aaaa", { format: "based-bug-report", id: "20261111-170000-aaaa", createdAt: "2026-11-11T17:00:00.000Z", note: "Older", realText: false, recording: { events: [1, 2] }, layout: { issues: [] } });
      put("20261111-180000-bbbb", { format: "based-bug-report", id: "20261111-180000-bbbb", createdAt: "2026-11-11T18:00:00.000Z", note: "White box over the selected block", realText: false, screenshot: "screenshot.png", recording: { events: [1, 2, 3] }, layout: { issues: [{}] } }, true);
      put("broken", "{not json");
      put("other", { format: "something-else" });
      const r = await run(["reports"], {}, home);
      expect(r.code).toBe(0);
      expect(r.out.indexOf("White box")).toBeLessThan(r.out.indexOf("Older"));
      expect(r.out).toContain("3 events, 1 layout issue, screenshot");
      expect(r.out).toContain(join(dir, "20261111-180000-bbbb"));
      expect(r.out).not.toContain("broken");
      const j = await run(["reports", "--json", "--limit", "1"], {}, home);
      expect(JSON.parse(j.out)).toHaveLength(1);
      expect((await run(["reports"], {}, join(home, "nobody"))).out).toContain("No problem reports");
      expect(() => parseArgs(["reports", "x"])).toThrow("takes no arguments");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
