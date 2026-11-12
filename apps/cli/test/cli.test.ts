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

  it("ask gibt dem Hauptagenten einen Auftrag (seit BSD-221 Teil 3e bietet der TS-Server ask_main_agent)", async () => {
    const r = await run(["ask", "Do it"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Sent to the main agent");
    // --wait: der Lauf entsteht erst in Based – ehrlicher Hinweis statt einem falschen Lauf zu folgen
    const w = await run(["ask", "Do it", "--wait"]);
    expect(w.code).toBe(1);
    expect(w.err).toContain("no run id to follow");
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

// BSD-30: Probelauf der Umstellung auf einem Archiv – ohne Server, ohne Token, schreibt nichts.
describe("based check", () => {
  it("liest ein Based-Archiv, rechnet die Umstellung und meldet OK; kaputte Datei und Dubletten geben Fehler", async () => {
    const { createPage, dbops, MemoryPersistence, WorkspaceStore, writeArchive, writeArchivePackage } = await import("@based/core");
    const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence(), propertyRecords: false });
    const page = createPage(store, { title: "Home" });
    const made = dbops.createDatabase(store, { parent: "b:" + page, title: "Tasks" });
    dbops.addProperty(store, made.databaseID, "Due", "date");
    const dir = mkdtempSync(join(tmpdir(), "based-check-"));
    try {
      const plain = join(dir, "export.based.jsonl"), zip = join(dir, "export.based.zip"), bad = join(dir, "bad.based.jsonl"), junk = join(dir, "junk.txt");
      writeFileSync(plain, writeArchive(store));
      writeFileSync(zip, writeArchivePackage(store, () => undefined).zip);
      const before = readFileSync(plain, "utf8");
      for (const file of [plain, zip]) {
        const r = await run(["check", file]);
        expect(r.err).toBe("");
        expect(r.code).toBe(0);
        expect(r.out).toContain("Databases: 1");
        expect(r.out).toContain("Split and join gives the same database: yes, all");
        expect(r.out).toContain("Result: OK");
      }
      expect(readFileSync(plain, "utf8")).toBe(before);
      const json = JSON.parse((await run(["check", plain, "--json"])).out) as { ok: boolean; databases: number; properties: number };
      expect(json).toMatchObject({ ok: true, databases: 1 });
      expect(json.properties).toBe(store.databases.get(made.databaseID)!.properties.length);
      // doppelte Property-ID: nicht umstellbar, Exit-Code 1
      const first = store.databases.get(made.databaseID)!.properties[1]!;
      writeFileSync(bad, before.replace(JSON.stringify(first.id), JSON.stringify(store.databases.get(made.databaseID)!.properties[0]!.id)));
      const refused = await run(["check", bad]);
      expect(refused.code).toBe(1);
      expect(refused.out).toContain("NOT OK");
      writeFileSync(junk, "hello");
      expect((await run(["check", junk])).code).toBe(1);
      expect((await run(["check", join(dir, "missing.zip")])).err).toContain("can't read");
      expect((await run(["check"])).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
