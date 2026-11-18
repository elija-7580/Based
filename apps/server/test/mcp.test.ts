// MCP: Werkzeuge und Ressourcen über das offizielle SDK – über Streamable HTTP (/mcp, Bearer-Token) und stdio.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { authorKindOf, createPage } from "@based/core";
import { openWorkspace, SyncClient } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { AgentBrain, AGENT_TYPE, defaultMainAgent, listRecords, MAIN_AGENT_ID, PROJECT_TYPE, putRecord, RUN_TYPE, TASK_TYPE, type ProjectData } from "@based/brain";
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
      ["about_me", "add_row", "append_markdown", "ask_main_agent", "backlinks", "based_guide", "create_database", "create_page", "create_project", "create_view", "database_schema", "delete_view", "draw_board", "duplicate_page", "find_replace", "get_project", "get_run", "inbox", "list_databases", "list_files", "list_pages", "list_projects", "list_runs", "list_trash", "list_views", "move_page", "query_database", "read_board", "read_page", "recall", "related", "remember", "replace_page_content", "resolve_inbox", "restore_page", "search", "set_favorite", "trash_page", "update_database", "update_page", "update_project_status", "update_row", "update_view", "upload_file"].sort(),
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

  it("BSD-522: Schreiben über MCP setzt Herkunft „ai“ und Agent-Autor; in eine Seite des Nutzers → „mixed“", async () => {
    const { app, call } = await httpClient();
    const store = app.sync.store;
    const page = idIn(textOf(await call("create_page", { title: "From the agent", markdown: "First line" })));
    expect(store.blocks.get(page)?.origin).toBe("ai");
    const author = store.blocks.get(page)?.author;
    expect(author).toMatch(/^a-/);
    expect(authorKindOf(author)).toBe("agent");
    expect(store.workspace.authors?.[author!]?.kind).toBe("agent");
    const kids = store.children("b:" + page).map((id) => store.blocks.get(id)!);
    expect(kids.length).toBeGreaterThan(0);
    for (const k of kids) expect(k.author).toBe(author);
    // Seite des Nutzers (ohne Herkunft): ein Agent hängt an → gemischt; Lesen ändert nichts
    const mine = createPage(store, { title: "Mine" });
    expect(store.blocks.get(mine)?.origin).toBeUndefined();
    await call("read_page", { id: mine });
    expect(store.blocks.get(mine)?.origin).toBeUndefined();
    await call("append_markdown", { id: mine, markdown: "Added by the agent" });
    expect(store.blocks.get(mine)?.origin).toBe("mixed");
    // danach schreibt der Nutzer wieder ohne Agent-Kennung
    expect(store.actor).toBeUndefined();
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
    // Tippfehler, Ort der Seite, nur unterhalb einer Seite, nur Titel (wie Quick Find in der App)
    expect(textOf(await call("search", { query: "Zebrafnik" }))).toContain(`(id: ${id})`);
    expect(textOf(await call("search", { query: "Zebrafink", title_only: true }))).toMatch(/\(id: |No matches\./);
    expect(textOf(await call("search", { query: "Zebrafink", within: "nicht-vorhanden" }))).toBe("No matches.");

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

describe("MCP: Agent Brain (BSD-541)", () => {
  it("recall, related, about_me, remember – der Weg eines Agenten von der Frage bis zur gemerkten Tatsache", async () => {
    const { app, call, client } = await httpClient();
    expect(client.getInstructions()).toContain("Start with `recall`");
    expect(textOf(await call("based_guide", { topic: "brain" }))).toContain("remember(fact");
    expect(textOf(await call("about_me"))).toBe("Nothing saved about the user yet.");
    expect(textOf(await call("recall", { query: "" }))).toContain("Give a query");

    const adr = idIn(textOf(await call("create_page", { title: "ADR 0017", markdown: "Storage decisions." })));
    const plan = idIn(textOf(await call("create_page", { title: "Sync plan", markdown: `Devices sync through the server. See [ADR 0017](based://page/${adr}).` })));
    const proto = idIn(textOf(await call("create_page", { title: "Protocol v4", markdown: `Compact records for sync, see [ADR 0017](based://page/${adr}).` })));

    const saved = textOf(await call("remember", { fact: "Sync must work fully offline on every device.", type: "Preference", about: [plan] }));
    expect(saved).toMatch(/^Remembered \(id: [0-9A-Fa-f-]{36}\)\.$/);
    const mem = idIn(saved);
    expect(textOf(await call("remember", { fact: "sync must work fully offline on every device" }))).toContain("Already remembered");
    const r = (await call("remember", { fact: "x", about: ["missing"] }));
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("No page with id missing");
    expect(textOf(await call("remember", { fact: "Pays 900 € salary to an assistant." }))).toContain("To review");

    const out = textOf(await call("recall", { query: "what did we decide about sync?" }));
    expect(out).toContain(`## Memories\n- Sync must work fully offline on every device. (Preference; about: Sync plan; id: ${mem})`);
    expect(out).toContain(`(id: ${plan})`);
    expect(out).toContain(`(id: ${proto})`);
    expect(out).toContain("mentions: ADR 0017");
    expect(out).toContain(`## Connected\n- ADR 0017 (id: ${adr})`);
    expect(out).not.toContain("salary");

    const rel = textOf(await call("related", { id: adr }));
    expect(rel).toContain("Mentioned by:");
    expect(rel).toContain(`- Sync plan (id: ${plan})`);
    expect(textOf(await call("related", { id: plan }))).toContain(`Mentioned by:\n- Sync must work fully offline on every device. (id: ${mem})`);
    expect(textOf(await call("about_me"))).toContain("# Profile and preferences\n- Sync must work fully offline on every device.");

    // Was der Agent schreibt, trägt seine Herkunft (BSD-522) und liegt als normale Zeile in „Memories“.
    const store = app.pages.store;
    const brain = new AgentBrain(store);
    expect(brain.memories().find((m) => m.id === mem)).toMatchObject({ kind: "Preference", status: "Active" });
    expect(store.blocks.get(mem)!.origin).toBe("ai");

    // Ersetzen: die alte Tatsache bleibt als „Superseded“ und fällt aus dem Abruf.
    const next = textOf(await call("remember", { fact: "Sync must work offline on phones and laptops, tablets can wait.", type: "Preference", replaces: mem }));
    expect(next).toContain("the old memory is now Superseded");
    const again = textOf(await call("recall", { query: "sync offline" }));
    expect(again).toContain("tablets can wait");
    expect(again).not.toContain("fully offline on every device");
  });

  it("Berechtigungsregeln gelten auch für remember", async () => {
    const { app, call } = await httpClient();
    const store = app.pages.store;
    store.transact("rules", (tx) => putRecord(store, tx, AGENT_TYPE, MAIN_AGENT_ID, "Main", { ...defaultMainAgent(), permissions: { ...defaultMainAgent().permissions, rules: "deny based.remember" } }));
    const r = await call("remember", { fact: "Likes tea." });
    expect(r.isError).toBe(true);
    expect(new AgentBrain(store).memories()).toHaveLength(0);
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
      // BSD-541: der Weg, den Claude Code oder Codex lokal gehen
      expect(textOf((await client.callTool({ name: "remember", arguments: { fact: "Arbeitet am liebsten morgens.", type: "Preference" } })) as ToolResult)).toContain("Remembered");
      expect(textOf((await client.callTool({ name: "recall", arguments: { query: "morgens arbeiten" } })) as ToolResult)).toContain("Arbeitet am liebsten morgens.");
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

describe("MCP: Schema und Ansichten (BSD-221 Teil 3b, wie Swift NotionParityToolsTests)", () => {
  it("create_database, update_database, add_row, create_view/list_views/update_view/delete_view", async () => {
    const { app, call } = await httpClient();
    const page = textOf(await call("create_page", { title: "Home" }));
    const pageID = idIn(page) || /([0-9a-f-]{36})/.exec(page)![1]!;
    const created = await call("create_database", { title: "Tasks", parent_id: pageID, properties: { Status: "select", Due: "date", Points: "number" } });
    expect(created.isError).toBeFalsy();
    const dbID = textOf(created).split(" ")[2]!;
    const db = () => app.sync.store.databases.get(dbID)!;
    expect(db().properties.find((p) => p.name === "Status")?.type).toBe("select");
    expect(app.sync.store.blocks.get(db().blockID)?.type).toBe("databaseInline");

    const upd = await call("update_database", { database_id: dbID, add_options: { Status: ["Todo", "Done"] }, rename_properties: { Points: "Estimate" }, delete_properties: ["Due"] });
    expect(textOf(upd)).toContain("Updated database");
    expect(db().properties.some((p) => p.name === "Due")).toBe(false);
    expect(db().properties.some((p) => p.name === "Estimate")).toBe(true);
    // Tippfehler: nichts wird geändert
    const bad = await call("update_database", { database_id: dbID, title: "Neu", delete_properties: ["Gibts nicht"] });
    expect(bad.isError).toBe(true);
    expect(db().title).toBe("Tasks");
    expect((await call("update_database", { database_id: dbID, delete_properties: ["Name"] })).isError).toBe(true);

    expect((await call("add_row", { id: dbID, values: { Name: "A", Status: "Todo" } })).isError).toBeFalsy();
    const view = await call("create_view", { database_id: dbID, type: "board", name: "Open", filters: [{ property: "Status", op: "equals", value: "Todo" }], sorts: [{ property: "Estimate", direction: "descending" }], group_by: "Status" });
    expect(view.isError).toBeFalsy();
    const viewID = /Created view (\S+)\./.exec(textOf(view))![1]!;
    const views = textOf(await call("list_views", { database_id: dbID }));
    expect(views).toContain("Open");
    expect(views).toContain("Status equals Todo");
    expect(views).toContain("Estimate desc");
    expect(views).toContain("group by Status");
    await call("update_view", { view_id: viewID, filters: [], name: "All" });
    const after = textOf(await call("list_views", { database_id: dbID }));
    expect(after).toContain("- All");
    expect(after).not.toContain("Status equals");
    expect((await call("create_view", { database_id: dbID, type: "board", filters: [{ property: "Status", value: "Gibts nicht" }] })).isError).toBe(true);
    expect(textOf(await call("delete_view", { view_id: viewID }))).toContain("Deleted view");
    expect(textOf(await call("list_views", { database_id: dbID }))).not.toContain(viewID);
    expect((await call("create_database", { title: "X", properties: { A: "hologram" } })).isError).toBe(true);
  });
});

describe("MCP: Projekte (BSD-221 Teil 3c)", () => {
  it("list_projects mit Status-Filter, get_project nach id oder Name mit Läufen", async () => {
    const { app, call } = await httpClient();
    const store = app.sync.store;
    expect(textOf(await call("list_projects"))).toBe("No projects yet.");
    const p1 = "44444444-4444-4444-8444-444444444444", p2 = "55555555-5555-4555-8555-555555555555", r1 = "66666666-6666-4666-8666-666666666666";
    store.transact("projects", (tx) => {
      putRecord(store, tx, PROJECT_TYPE, p1, "Website", { v: 1, status: "active", goal: "Relaunch", createdAt: 0, budgetEUR: 2 });
      putRecord(store, tx, PROJECT_TYPE, p2, "Archiv", { v: 1, status: "done", createdAt: 0 });
      putRecord(store, tx, RUN_TYPE, r1, "Draft copy", { v: 1, kind: "main", status: "done", agentID: MAIN_AGENT_ID, title: "Draft copy", startedAt: 10, usage: { inputTokens: 1, outputTokens: 1, costUSD: 0 }, costEUR: 0, projectID: p1 });
    });
    const list = textOf(await call("list_projects"));
    expect(list.split("\n")).toEqual([`- Archiv [done] (id: ${p2}) · 0 runs`, `- Website [active] (id: ${p1}) — Relaunch · 1 runs`]);
    expect(textOf(await call("list_projects", { status: "active" }))).not.toContain("Archiv");
    expect((await call("list_projects", { status: "bogus" })).isError).toBe(true);
    const got = textOf(await call("get_project", { project_id: "website" }));
    expect(got).toContain("# Website\nStatus: active");
    expect(got).toContain("Goal: Relaunch");
    expect(got).toContain("Recent runs:\n- [Done] Draft copy");
    expect((await call("get_project", { project_id: "nope" })).isError).toBe(true);
  });
});

describe("MCP: Projekte schreiben (BSD-221 Teil 3d)", () => {
  it("create_project (Duplikat, Status, Seite), update_project_status (Name, Status, Update auf der Seite)", async () => {
    const { app, call } = await httpClient();
    const store = app.sync.store;
    let r = textOf(await call("create_project", { name: "Publit", goal: "Launch the beta" }));
    expect(r).toMatch(/^Created project \[Publit\]\(based:\/\/page\/[0-9a-f-]+\) \(id: [0-9a-f-]+, active\)\.$/i);
    expect(textOf(await call("create_project", { name: "publit" }))).toContain("already exists");
    expect(listRecords<ProjectData>(store, PROJECT_TYPE)).toHaveLength(1);
    await call("create_project", { name: "Old", status: "Done" });
    expect(textOf(await call("list_projects", { status: "active" }))).not.toContain("Old");
    expect((await call("create_project", { name: "X", status: "Someday" })).isError).toBe(true);
    r = textOf(await call("update_project_status", { project: "publit", update: "Beta shipped", status: "Done" }));
    expect(r).toBe("Posted update to Publit (status done).");
    const p = listRecords<ProjectData>(store, PROJECT_TYPE).find((x) => x.name === "Publit")!;
    expect(p.data.status).toBe("done");
    expect(app.pages.read(p.data.pageID!)).toContain("Beta shipped");
    expect((await call("update_project_status", { project: "Publit", update: "x", status: "weird" })).isError).toBe(true);
    expect((await call("update_project_status", { project: "nope", update: "x" })).isError).toBe(true);
  });

  it("BSD-221 Teil 3e: Berechtigungsregeln gelten für Schreibzugriffe (deny, ask, Pfad); Lesen bleibt frei", async () => {
    const { app, call } = await httpClient();
    const created = textOf(await call("create_page", { title: "Secret plans" }));
    const secret = idIn(created);
    const other = idIn(textOf(await call("create_page", { title: "Notes" })));
    const store = app.sync.store;
    store.transact("rules", (tx) => putRecord(store, tx, AGENT_TYPE, MAIN_AGENT_ID, "Main agent", {
      ...defaultMainAgent(), permissions: { mode: "askEdits", rules: "deny based.trash_page\nask based.create_page\ndeny based.append_markdown(path:Secret plans/**)" },
    }));
    const trash = await call("trash_page", { id: other });
    expect(trash.isError).toBe(true);
    expect(textOf(trash)).toContain("Not allowed by the permission rules");
    const create = await call("create_page", { title: "x" });
    expect(create.isError).toBe(true);
    expect(textOf(create)).toContain("needs the user's approval");
    expect((await call("append_markdown", { id: secret, markdown: "more" })).isError).toBe(true);
    expect((await call("append_markdown", { id: other, markdown: "fine" })).isError).toBeFalsy();
    // Lesen ist nicht betroffen
    expect((await call("read_page", { id: secret })).isError).toBeFalsy();
    expect(store.blocks.get(other)?.trashedAt).toBeUndefined();
  });

  it("BSD-221 Teil 3e: eingeschaltete Skills sind Prompts (Argument input wird angehängt)", async () => {
    const { app, client } = await httpClient();
    const brain = new AgentBrain(app.sync.store);
    brain.ensure();
    brain.saveSkill({ name: "Weekly Review", description: "Sum up the week", body: "List what got done this week." });
    brain.saveSkill({ name: "Off Skill", description: "disabled", body: "x", enabled: false });
    const prompts = (await client.listPrompts()).prompts;
    expect(prompts.map((p) => p.name)).toEqual(["weekly-review"]);
    expect(prompts[0]).toMatchObject({ title: "Weekly Review", description: "Sum up the week" });
    const got = await client.getPrompt({ name: "weekly-review", arguments: { input: "Project Alpha" } });
    expect((got.messages[0]!.content as { text: string }).text).toBe("List what got done this week.\n\n---\nProject Alpha");
  });

  it("BSD-221 Teil 3e: resolve_inbox nur mit ausdrücklicher allow-Regel; erlauben reiht den Lauf wieder ein, ablehnen beendet ihn", async () => {
    const { app, call } = await httpClient();
    const store = app.sync.store;
    const mk = (id: string) => store.transact("run", (tx) => putRecord(store, tx, RUN_TYPE, id, "Tidy notes", {
      v: 1, kind: "sub", status: "needsYou", agentID: MAIN_AGENT_ID, title: "Tidy notes", startedAt: store.now(), usage: { inputTokens: 0, outputTokens: 0, costUSD: 0 }, costEUR: 0,
      approval: { callID: "c1", name: "trash_page", arguments: { id: "p1" } },
    } as never));
    mk("run-1"); mk("run-2");
    const refused = await call("resolve_inbox", { run_id: "run-1", decision: "allow" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("allow based.resolve_inbox");
    store.transact("rules", (tx) => putRecord(store, tx, AGENT_TYPE, MAIN_AGENT_ID, "Main agent", { ...defaultMainAgent(), permissions: { mode: "askEdits", rules: "allow based.resolve_inbox" } }));
    expect(textOf(await call("resolve_inbox", { run_id: "run-1", decision: "allow" }))).toContain("Allowed trash_page");
    const r1 = listRecords<{ status: string; resume?: { ok: boolean; callID: string }; approval?: unknown }>(store, RUN_TYPE).find((r) => r.id === "run-1")!;
    expect(r1.data).toMatchObject({ status: "queued", resume: { ok: true, callID: "c1" } });
    expect(r1.data.approval).toBeUndefined();
    expect(textOf(await call("resolve_inbox", { run_id: "run-2", decision: "deny" }))).toContain("Declined");
    expect(listRecords<{ status: string }>(store, RUN_TYPE).find((r) => r.id === "run-2")!.data.status).toBe("failed");
    expect((await call("resolve_inbox", { run_id: "run-2", decision: "allow" })).isError).toBe(true); // wartet nicht mehr
    expect((await call("resolve_inbox", { run_id: "nope", decision: "allow" })).isError).toBe(true);
  });

  it("BSD-221 Teil 3e: ask_main_agent legt einen Auftrag für die Startseite an (Quelle mcp)", async () => {
    const { app, call } = await httpClient();
    const r = await call("ask_main_agent", { task: "Summarize this week's notes" });
    expect(textOf(r)).toContain("Sent to the main agent");
    const tasks = listRecords<{ state: string; input: string; source?: string }>(app.sync.store, TASK_TYPE);
    expect(tasks.map((t) => t.data)).toEqual([expect.objectContaining({ state: "received", input: "Summarize this week's notes", source: "mcp" })]);
    expect((await call("ask_main_agent", { task: "" })).isError).toBe(true);
  });
});

// BSD-508: Whiteboards über MCP – zeichnen als Text, knapp zurücklesen.
describe("Whiteboard über MCP", () => {
  it("draw_board legt ein Board an und verknüpft eine Seite; read_board liest es knapp", async () => {
    const { call } = await httpClient();
    const page = idIn(textOf(await call("create_page", { title: "Lecture 5", markdown: "Notes" })));
    const out = textOf(await call("draw_board", { title: "Map", script: `page p: ${page}\nnote n: On the exam\np -> n: explains` }));
    expect(out).toContain("3 added");
    const board = idIn(out);
    const read = textOf(await call("read_board", { id: board }));
    expect(read).toContain(`page ${page} "Lecture 5"`);
    expect(read).toMatch(/\w+ -> \w+: explains/);
  });

  it("Elija 18.11.: upload_file legt ein Bild in den Speicher und aufs Board; list_files findet es; HTTP liest keine lokalen Pfade", async () => {
    const { call } = await httpClient();
    const board = idIn(textOf(await call("draw_board", { title: "Moodboard", script: "text t: Ideas {color=blue}" })));
    // 2 × 1 PNG (Kopf genügt für die Maße).
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0AAQ1Ml4gAAAAASUVORK5CYII=", "base64");
    const up = textOf(await call("upload_file", { name: "dot.png", data: png.toString("base64"), board, at: "40,200" }));
    expect(up).toMatch(/Stored “dot.png” \(2x1, 1 KB\): based-asset:[0-9a-f]{64}/);
    expect(up).toContain("1 added");
    const read = textOf(await call("read_board", { id: board }));
    expect(read).toMatch(/image "dot.png" based-asset:[0-9a-f]{64} @40,200 8x8 \{agent\}/);
    expect(textOf(await call("list_files", { query: "dot" }))).toMatch(/"dot.png" 2x1/);
    const local = await call("upload_file", { path: "/etc/hosts" });
    expect(local.isError).toBe(true);
    expect((await call("upload_file", { url: "http://example.com/x.png" })).isError).toBe(true);
    expect(textOf(await call("upload_file", { url: "https://127.0.0.1/x.png" }))).toContain("not reachable");
  });
});
