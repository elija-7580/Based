// MCP: Werkzeuge und Ressourcen über das offizielle SDK – über Streamable HTTP (/mcp, Bearer-Token) und stdio.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkspace, SyncClient } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { MAIN_AGENT_ID, putRecord, RUN_TYPE } from "@based/brain";
import { startApp, TOKEN } from "./helpers.js";

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const textOf = (r: unknown) => (r as ToolResult).content.map((c) => c.text).join("\n");

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

async function httpClient(token = TOKEN) {
  const app = await startApp();
  cleanup.push(() => app.close());
  const client = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${app.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  cleanup.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
  return { app, client, call };
}

const idIn = (s: string) => /id: ([0-9A-Fa-f-]{36})/.exec(s)?.[1] ?? "";

describe("MCP über Streamable HTTP", () => {
  it("initialize mit Anleitung, Werkzeugliste", async () => {
    const { client } = await httpClient();
    expect(client.getInstructions()).toContain("Based is a Notion-like workspace");
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["add_row", "append_markdown", "backlinks", "based_guide", "create_page", "database_schema", "duplicate_page", "find_replace", "get_run", "inbox", "list_databases", "list_pages", "list_runs", "list_trash", "move_page", "query_database", "read_page", "replace_page_content", "restore_page", "search", "set_favorite", "trash_page", "update_page", "update_row"].sort(),
    );
  });

  it("BSD-221 Teil 3a: list_runs, get_run, inbox aus den Lauf-Records", async () => {
    const { app, call } = await httpClient();
    const store = app.sync.store;
    expect(textOf(await call("list_runs"))).toBe("No runs yet.");
    expect(textOf(await call("inbox"))).toBe("Nothing needs you right now.");
    const usage = { inputTokens: 1200, outputTokens: 300, costUSD: 0.02 };
    const run = (id: string, title: string, status: string, startedAt: number, extra: object = {}) =>
      ({ v: 1, kind: "main", status, agentID: MAIN_AGENT_ID, title, startedAt, usage, costEUR: 0.018, ...extra });
    const parent = "11111111-1111-4111-8111-111111111111", child = "22222222-2222-4222-8222-222222222222", waiting = "33333333-3333-4333-8333-333333333333";
    store.transact("runs", (tx) => {
      putRecord(store, tx, RUN_TYPE, parent, "Plan trip", run(parent, "Plan trip", "done", 100, { endedAt: 160, result: "Booked.", model: "anthropic/x", sandbox: "docker:based-run-1" }));
      putRecord(store, tx, RUN_TYPE, child, "Find hotel", run(child, "Find hotel", "done", 110, { kind: "subagent", parentID: parent }));
      putRecord(store, tx, RUN_TYPE, waiting, "Send mail", run(waiting, "Send mail", "needsYou", 200, { result: "May I send the mail?\nDetails…" }));
    });
    const list = textOf(await call("list_runs"));
    expect(list.split("\n").map((l) => l.slice(0, 22))).toEqual(["- [Needs you] Send mai", "- [Done] Find hotel (i", "- [Done] Plan trip (id"]);
    expect(textOf(await call("list_runs", { status: "Needs you" }))).toContain(waiting);
    expect(textOf(await call("list_runs", { status: "running" }))).toBe("No runs with status Running.");
    expect((await call("list_runs", { status: "bogus" })).isError).toBe(true);
    expect(textOf(await call("list_runs", { limit: 1 }))).toContain("… 2 more");
    const got = textOf(await call("get_run", { run_id: parent }));
    expect(got.split("\n")[0]).toMatch(/^- \[Done\] Plan trip \(id: /);
    expect(got).toContain("\n\nResult:\nBooked.");
    expect(got).toContain("Sandbox: docker:based-run-1");
    expect(got).toContain("Sub-runs:\n- [Done] Find hotel");
    expect(got).toContain("Usage: 1200 in / 300 out tokens · €0.018");
    expect((await call("get_run", { run_id: "nope" })).isError).toBe(true);
    const inbox = textOf(await call("inbox"));
    expect(inbox).toContain("1 run needs you:");
    expect(inbox).toContain("May I send the mail?");
    expect(inbox).not.toContain("Details…");
  });

  it("BSD-221 Teil 2: find_replace, move_page, duplicate_page, backlinks, set_favorite", async () => {
    const { app, call } = await httpClient();
    const store = app.sync.store;
    const a = idIn(textOf(await call("create_page", { title: "Alpha", markdown: "Hallo **Welt**, Hallo Welt" })));
    const b = idIn(textOf(await call("create_page", { title: "Beta", markdown: `Siehe [Alpha](based://page/${a})` })));
    expect(textOf(await call("find_replace", { id: a, find: "Hallo", replace: "Servus" }))).toBe("Replaced 1 match(es) in Alpha.");
    expect(textOf(await call("read_page", { id: a }))).toContain("Servus **Welt**, Hallo Welt");
    expect(textOf(await call("find_replace", { id: a, find: "Hallo", replace: "Grüß", all: true }))).toBe("Replaced 1 match(es) in Alpha.");
    expect(textOf(await call("find_replace", { id: a, find: "fehlt", replace: "x" }))).toBe("No match for that text in Alpha.");

    expect(textOf(await call("backlinks", { id: a }))).toBe(`- Beta (id: ${b})`);
    expect(textOf(await call("backlinks", { id: b }))).toBe("No backlinks.");

    await call("move_page", { id: b, parent_id: a });
    expect(store.blocks.get(b)?.parent).toBe("b:" + a);
    expect((await call("move_page", { id: a, parent_id: b })).isError).toBe(true); // in die eigene Unterseite
    await call("move_page", { id: b });
    expect(store.blocks.get(b)?.parent).toBe("w");

    const copy = idIn(textOf(await call("duplicate_page", { id: a })));
    expect(copy).not.toBe(a);
    expect(textOf(await call("read_page", { id: copy }))).toContain("Servus **Welt**, Grüß Welt");

    await call("set_favorite", { id: a, favorite: true });
    expect(store.workspace.favorites).toContain(a);
    await call("set_favorite", { id: a, favorite: false });
    expect(store.workspace.favorites).not.toContain(a);
    expect((await call("set_favorite", { id: "nope", favorite: true })).isError).toBe(true);
  });

  it("ohne gültigen Token: 401, keine Verbindung", async () => {
    await expect(httpClient("falsch")).rejects.toThrow();
  });

  it("Seiten anlegen, lesen, suchen, bearbeiten, Papierkorb", async () => {
    const { app, call } = await httpClient();
    const created = await call("create_page", { markdown: "# Projektplan\n\nErster Absatz\n\n- Punkt eins\n- Punkt zwei\n\n- [ ] Aufgabe" });
    const id = idIn(textOf(created));
    expect(app.sync.store.blocks.get(id)?.text).toBe("Projektplan");
    expect(textOf(await call("read_page", { id }))).toBe("# Projektplan\n\nErster Absatz\n\n- Punkt eins\n- Punkt zwei\n\n- [ ] Aufgabe\n");

    const sub = idIn(textOf(await call("create_page", { title: "Unterseite", parent: id, markdown: `Siehe [Plan](based://page/${id})` })));
    expect(textOf(await call("list_pages", { parent: id }))).toBe(`- Unterseite (id: ${sub})`);
    expect(textOf(await call("list_pages"))).toBe(`- Projektplan (id: ${id})`);
    // Link auf eine Seite wird eine Erwähnung und kommt als based://page-Link zurück.
    expect(textOf(await call("read_page", { id: sub }))).toContain(`(based://page/${id})`);

    await call("append_markdown", { id, markdown: "## Nachtrag\n\nMehr Text mit Suchwort Zebrafink" });
    expect(textOf(await call("read_page", { id }))).toContain("## Nachtrag");
    expect(textOf(await call("search", { query: "Zebrafink" }))).toContain(`(id: ${id})`);

    await call("replace_page_content", { id, markdown: "Nur noch das" });
    const md = textOf(await call("read_page", { id }));
    expect(md).toContain("Nur noch das");
    expect(md).not.toContain("Punkt eins");
    expect(app.sync.store.blocks.has(sub)).toBe(true); // Unterseiten bleiben

    await call("update_page", { id, title: "Neuer Titel", icon: "🚀" });
    expect(app.sync.store.blocks.get(id)?.props?.icon).toBe("🚀");
    expect(textOf(await call("read_page", { id }))).toMatch(/^# Neuer Titel/);

    expect(textOf(await call("trash_page", { id }))).toContain("Trash");
    expect(textOf(await call("list_pages"))).toBe("(none)");
    expect(textOf(await call("list_trash"))).toContain(id);
    const editTrashed = await call("append_markdown", { id, markdown: "x" });
    expect(editTrashed.isError).toBe(true);
    await call("restore_page", { id });
    expect(textOf(await call("list_pages"))).toContain(id);

    const missing = await call("read_page", { id: "gibt-es-nicht" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("No page");
  });

  it("Ressourcen: Anleitung und Seiten", async () => {
    const { client, call } = await httpClient();
    const id = idIn(textOf(await call("create_page", { title: "Ressource", markdown: "Inhalt" })));
    const list = (await client.listResources()).resources.map((r) => r.uri);
    expect(list).toContain("based://docs/overview");
    expect(list).toContain(`based://page/${id}`);
    const page = await client.readResource({ uri: `based://page/${id}` });
    expect((page.contents[0] as { text: string }).text).toBe("# Ressource\n\nInhalt\n");
    const guide = await client.readResource({ uri: "based://docs/markdown" });
    expect((guide.contents[0] as { text: string }).text).toContain("Markdown");
  });

  it("MCP-Änderungen kommen per Sync v2 bei Geräten an", async () => {
    const { app, call } = await httpClient();
    const id = idIn(textOf(await call("create_page", { title: "Vom Agenten", markdown: "Hallo Gerät" })));
    const d = openWorkspace(openNodeDatabase());
    await new SyncClient(d.store, d.persistence, { baseURL: app.url, token: TOKEN }).syncOnce();
    expect(d.store.blocks.get(id)?.text).toBe("Vom Agenten");
    expect(d.store.children("b:" + id).length).toBe(1);
  });

  it("GET /mcp: 405 (kein SSE)", async () => {
    const app = await startApp();
    cleanup.push(() => app.close());
    const r = await fetch(`${app.url}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(405);
  });
});

describe("MCP über stdio", () => {
  it("startet ohne Token, schreibt in die Datenbank", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-mcp-"));
    const db = join(dir, "based.sqlite");
    const root = fileURLToPath(new URL("..", import.meta.url));
    const transport = new StdioClientTransport({
      command: join(root, "node_modules/.bin/tsx"),
      args: [join(root, "src/main.ts"), "--stdio", "--db", db],
      env: { PATH: process.env.PATH ?? "", BASED_LOG_LEVEL: "warning" },
      stderr: "ignore",
    });
    const client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
    try {
      const r = (await client.callTool({ name: "create_page", arguments: { title: "Über stdio" } })) as ToolResult;
      expect(textOf(r)).toContain("Created Über stdio");
    } finally {
      await client.close();
    }
    const after = openWorkspace(openNodeDatabase(db));
    expect([...after.store.blocks.values()].map((b) => b.text)).toContain("Über stdio");
  }, 30_000);
});

describe("MCP: Datenbanken (BSD-221)", () => {
  it("auflisten, Schema, abfragen, Zeile anlegen und ändern – Werte als Text, Properties per Name", async () => {
    const { app, call } = await httpClient();
    const { createDatabase, addProperty } = await import("@based/core");
    const store = app.pages.store;
    const created = createDatabase(store, { parent: "w", title: "Tasks" });
    const dbID = created.databaseID;
    addProperty(store, dbID, "Status", "select");
    addProperty(store, dbID, "Points", "number");
    addProperty(store, dbID, "Due", "date");

    const list = textOf(await call("list_databases"));
    expect(list).toContain(`Tasks (id: ${dbID})`);
    expect(list).toContain("Points: number");
    expect(textOf(await call("database_schema", { id: dbID }))).toContain("| Due | date | YYYY-MM-DD or YYYY-MM-DD HH:mm |");

    const added = textOf(await call("add_row", { id: dbID, values: { Name: "Write docs", Status: "Doing", Points: "3", Due: "2026-11-12" } }));
    const rowID = /Added row ([0-9a-f-]{36})/.exec(added)![1]!;
    expect(store.databases.get(dbID)!.properties.find((p) => p.name === "Status")!.options!.map((o) => o.name)).toContain("Doing");
    await call("add_row", { id: dbID, values: { Name: "Fix bug", Points: "8" } });

    let rows = textOf(await call("query_database", { id: dbID, sort: "Points", descending: true }));
    expect(rows.split("\n")[0]).toContain("[Fix bug]");
    expect(rows).toContain(`[Write docs](based://page/${rowID}) — `);
    expect(rows).toContain("Status: Doing");
    expect(textOf(await call("query_database", { id: dbID, search: "doing" })).split("\n")).toHaveLength(1);

    await call("update_row", { id: rowID, values: { Points: "5", Status: "" } });
    rows = textOf(await call("query_database", { id: dbID, search: "write" }));
    expect(rows).toContain("Points: 5");
    expect(rows).not.toContain("Status:");

    // Fehler als Antwort, nichts halb geschrieben
    const before = textOf(await call("query_database", { id: dbID })).split("\n").length;
    const bad = await call("add_row", { id: dbID, values: { Name: "X", Points: "lots" } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("isn't a valid number");
    expect(textOf(await call("query_database", { id: dbID })).split("\n").length).toBe(before);
    expect((await call("update_row", { id: rowID, values: { Nope: "1" } })).isError).toBe(true);
    expect((await call("query_database", { id: "missing" })).isError).toBe(true);
  });
});
