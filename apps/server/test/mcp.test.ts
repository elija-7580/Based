// MCP: Werkzeuge und Ressourcen über das offizielle SDK – über Streamable HTTP (/mcp, Bearer-Token) und stdio.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkPreviews } from "../src/file-tools.js";
import { authorKindOf, createPage } from "@based/core";
import { openWorkspace, SyncClient } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { AgentBrain, AgentStore, WorkspaceTools, AGENT_TYPE, defaultMainAgent, listRecords, MAIN_AGENT_ID, PROJECT_TYPE, putRecord, RUN_TYPE, TASK_TYPE, type ProjectData } from "@based/brain";
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
  it("initialize mit Anleitung; die Werkzeugliste ist kurz (Kern + more_tools/run_tool), ?tools=all zeigt alle", async () => {
    const { client, app } = await httpClient();
    expect(client.getInstructions()).toContain("Based is a Notion-like workspace");
    const short = (await client.listTools()).tools;
    expect(short.map((t) => t.name).sort()).toEqual(
      ["add_row", "append_markdown", "based_guide", "create_page", "database_schema", "edit_blocks", "list_databases", "list_pages", "more_tools", "query_database", "read_blocks", "read_page", "recall", "remember", "run_tool", "search", "undo_last", "update_page", "update_row"],
    );
    const all = new Client({ name: "test", version: "1" });
    await all.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp?tools=all`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    cleanup.push(() => all.close());
    const full = (await all.listTools()).tools;
    expect(full.map((t) => t.name).sort()).toEqual(
      ["about_me", "add_row", "add_rows", "append_markdown", "ask_main_agent", "backlinks", "based_guide", "create_database", "create_page", "create_project", "create_teamspace", "create_view", "database_schema", "delete_forever", "delete_teamspace", "delete_view", "draw_board", "due", "duplicate_page", "edit_blocks", "empty_trash", "export_page", "export_workspace", "find_replace", "get_project", "get_run", "get_workspace", "import_files", "inbox", "list_connections", "list_databases", "list_files", "list_meetings", "list_pages", "list_projects", "list_runs", "list_schedules", "list_shares", "list_skills", "list_trash", "list_views", "load_skill", "move_page", "notion_import", "query_database", "read_blocks", "read_board", "read_meeting", "read_page", "read_skill_file", "recall", "related", "remember", "replace_page_content", "resolve_inbox", "restore_page", "revoke_share", "save_skill", "search", "set_favorite", "share_page", "trash_page", "undo_last", "update_database", "update_meeting", "update_page", "update_project", "update_project_status", "update_row", "update_rows", "update_schedule", "update_teamspace", "update_view", "update_workspace", "upload_file"].sort(),
    );
    // Die kurze Liste kostet höchstens ein Drittel der ganzen (gemessen an Beschreibung + Schema).
    const size = (l: unknown[]) => JSON.stringify(l).length;
    expect(size(short)).toBeLessThan(size(full) / 3);
    expect(size(short), "kurze Liste bleibt unter ~3.500 Token").toBeLessThan(14_000);
  });

  it("more_tools nennt den Rest, beschreibt ihn auf Wunsch; run_tool ruft auf – mit den Regeln des gemeinten Werkzeugs", async () => {
    const { app, call } = await httpClient();
    const list = textOf(await call("more_tools"));
    expect(list).toContain("Databases:");
    expect(list).toContain("- update_view: ");
    expect(list).not.toContain("- read_page:");
    expect(textOf(await call("more_tools", { query: "trash" }))).toContain("- empty_trash: ");
    const desc = textOf(await call("more_tools", { names: ["move_page"] }));
    expect(desc).toContain("## move_page (writes)");
    expect(desc).toContain("Arguments: {");
    const id = idIn(textOf(await call("create_page", { title: "Via gateway" })));
    expect(textOf(await call("run_tool", { name: "set_favorite", args: { id, favorite: true } }))).toMatch(/favorite/i);
    expect((await call("run_tool", { name: "set_favorite", args: { id: "nope", favorite: true } })).isError).toBe(true);
    // Eine deny-Regel für das gemeinte Werkzeug gilt auch über run_tool.
    new AgentStore(app.sync.store).saveMain((d) => { d.permissions = { ...d.permissions, rules: "deny based.trash_page" }; });
    const refused = await call("run_tool", { name: "trash_page", args: { id } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("Not allowed by the permission rules");
    expect(textOf(await call("run_tool", { name: "run_tool", args: {} })), "kein Schachteln").toContain("Databases:");
  });

  it("export_page: Markdown kommt direkt und als Datei-Adresse; HTML und Word als Datei", async () => {
    const { call } = await httpClient();
    const id = idIn(textOf(await call("create_page", { title: "Report", markdown: "# Findings\n\nAll **good**." })));
    const md = textOf(await call("export_page", { id }));
    expect(md).toContain("Exported “Report” as Markdown.");
    expect(md).toMatch(/File “Report\.md” \(\d+ KB\): based-asset:[0-9a-f]{64}/);
    expect(md).toContain("All **good**.");
    expect(textOf(await call("export_page", { id, format: "html" }))).toMatch(/Exported 1 page as HTML\.\nFile “Report\.html”/);
    expect(textOf(await call("export_page", { id, format: "docx" }))).toMatch(/File “Report\.docx” \(\d+ KB\): based-asset:/);
    expect(textOf(await call("export_workspace", { format: "archive" }))).toMatch(/Archived \d+ records\.\nFile “.*\.based\.zip”/);
    const refused = await call("export_page", { id, path: "/tmp/x.md" });
    expect(refused.isError, "Pfade nur über stdio").toBe(true);
  });

  it("import_files: Text und hochgeladene Dateien über die Importer der App", async () => {
    const { app, call } = await httpClient();
    const store = app.sync.store;
    const parent = idIn(textOf(await call("create_page", { title: "Inbox" })));
    const first = textOf(await call("import_files", { text: "# Trip plan\n\n- [ ] Book train\n- [x] Pack", name: "Trip plan.md", parent }));
    expect(first).toMatch(/^Imported 1 page\./);
    const page = idIn(first);
    expect(store.blocks.get(page)!.parent).toBe("b:" + parent);
    expect(textOf(await call("read_page", { id: page }))).toContain("- [x] Pack");
    // CSV wird eine Datenbank; die Datei kommt aus dem Dateispeicher (upload_file → ref)
    const up = textOf(await call("upload_file", { name: "Books.csv", data: Buffer.from("Name,Pages\nDune,612\nEmma,474\n").toString("base64") }));
    const ref = /based-asset:[0-9a-f]{64}/.exec(up)![0];
    const csv = textOf(await call("import_files", { refs: [ref] }));
    expect(csv).toContain("1 database");
    expect(csv).toContain("2 rows");
    expect(textOf(await call("list_databases"))).toContain("Books");
    expect((await call("import_files", {})).isError).toBe(true);
    expect((await call("import_files", { path: "/etc" })).isError, "Pfade nur über stdio").toBe(true);
    expect((await call("import_files", { refs: ["based-asset:" + "0".repeat(64)] })).isError).toBe(true);
  });

  it("import_files über stdio: ein Ordner von der Platte wird mit Unterordnern importiert; versteckte Dateien nicht", async () => {
    const { app } = await httpClient();
    const dir = mkdtempSync(join(tmpdir(), "based-import-"));
    mkdirSync(join(dir, "Notes", "Sub"), { recursive: true });
    mkdirSync(join(dir, "Notes", ".git"));
    writeFileSync(join(dir, "Notes", "Alpha.md"), "# Alpha\n\nFirst.");
    writeFileSync(join(dir, "Notes", "Sub", "Beta.md"), "# Beta\n\nSecond.");
    writeFileSync(join(dir, "Notes", ".git", "config.md"), "# secret");
    const tools = app.pages.tools({ assets: app.assets, localFiles: true });
    const r = await tools.call("import_files", { path: join(dir, "Notes") });
    expect(r.isError, r.text).toBe(false);
    const titles = [...app.sync.store.blocks.values()].filter((b) => b.type === "page").map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b.text)));
    expect(titles.join("|")).toContain("Alpha");
    expect(titles.join("|")).toContain("Beta");
    expect(titles.join("|")).not.toContain("secret");
    expect((await tools.call("import_files", { path: "Notes" })).text).toBe("path must be absolute.");
    expect((await tools.call("import_files", { path: join(dir, "nope") })).isError).toBe(true);
  });

  it("notion_import: ohne Token am Server startet nichts; das Token nennt kein Werkzeug", async () => {
    const { call } = await httpClient();
    const old = process.env.BASED_NOTION_TOKEN;
    delete process.env.BASED_NOTION_TOKEN;
    try {
      expect(textOf(await call("notion_import", { action: "status" }))).toBe("No Notion import has run on this server since it started.");
      const r = await call("notion_import", { action: "start" });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("BASED_NOTION_TOKEN");
      expect(textOf(await call("notion_import", { action: "cancel" }))).toBe("No Notion import is running.");
      process.env.BASED_NOTION_TOKEN = "secret_test";
      const bad = await call("notion_import", { action: "start", links: ["https://example.com/x"] });
      expect(textOf(bad)).toBe("None of the links is a Notion page or database link.");
      expect(textOf(bad)).not.toContain("secret_test");
    } finally {
      if (old === undefined) delete process.env.BASED_NOTION_TOKEN; else process.env.BASED_NOTION_TOKEN = old;
    }
  });

  it("Teilen: ansehen und entziehen immer; freigeben fragt in der Inbox, außer Agenten dürfen frei arbeiten", async () => {
    const { app, call } = await httpClient();
    const store = app.sync.store;
    const id = idIn(textOf(await call("create_page", { title: "Roadmap" })));
    expect(textOf(await call("list_shares", { id }))).toBe("Not shared.");
    const asked = textOf(await call("share_page", { id, kind: "publish" }));
    expect(asked).toContain("Asked the user in Based's inbox");
    expect(asked).toContain("Publish “Roadmap” to the web");
    expect(textOf(await call("list_shares", { id }))).toBe("Not shared.");
    expect((await call("share_page", { id, kind: "link", role: "full" })).isError, "ungültiges fragt nicht").toBe(true);
    // Der Mensch stimmt in der App zu: dort gibt es das Werkzeug nicht, der Server führt es aus.
    const req = /request ([^)\s]+)\)/.exec(asked)![1]!;
    const appTools = new WorkspaceTools(store, { groups: ["pages"] });
    expect(appTools.resolveRequest(req, true).text).toBe("Allowed. Your Based server carries it out.");
    await vi.waitFor(async () => expect(textOf(await call("list_shares", { id }))).toContain("Published to the web"));
    expect(textOf(await call("get_run", { run_id: req }))).toContain("Published “Roadmap”");
    // „Work freely“: ohne Rückfrage.
    new AgentStore(store).saveMain((d) => { d.permissions = { ...d.permissions, mode: "free" }; });
    const shared = textOf(await call("share_page", { id, kind: "link", role: "view", label: "For Ada" }));
    expect(shared).toMatch(/Shared “Roadmap” \(share: [^,]+, can view\): \/s\/bdl_/);
    const sid = /share: ([^,]+),/.exec(shared)![1]!;
    expect(textOf(await call("revoke_share", { share: sid }))).toBe("Revoked.");
    expect(textOf(await call("list_shares", { id }))).not.toContain("For Ada");
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

  it("Agent-Parität: MCP meldet genau die Werkzeuge der einen Schicht an – Name, Beschreibung, Schema, Einordnung", async () => {
    const { app, call } = await httpClient();
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.url}/mcp?tools=all`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
    cleanup.push(() => client.close());
    const listed = (await client.listTools()).tools;
    const layer = app.pages.tools({ assets: app.assets }).all;
    expect(listed.map((t) => t.name)).toEqual(layer.map((d) => d.spec.name));
    for (const d of layer) {
      const t = listed.find((x) => x.name === d.spec.name)!;
      expect(t.description).toBe(d.spec.description);
      expect(t.inputSchema).toEqual(d.spec.inputSchema);
      expect(t.annotations?.readOnlyHint, d.spec.name).toBe(!d.write);
    }
    const hint = (name: string) => listed.find((t) => t.name === name)!.annotations;
    expect(hint("list_views")).toEqual({ readOnlyHint: true });
    for (const name of ["delete_view", "update_database", "trash_page", "replace_page_content"]) expect(hint(name)?.destructiveHint, name).toBe(true);
    expect(hint("append_markdown")?.destructiveHint).toBe(false);
    // Fehler in den Argumenten kommen als Antwort des Werkzeugs (das Modell liest sie), nicht als Protokollfehler
    const bad = await call("append_markdown", { id: "x", text: "y" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toBe("Unknown argument text. Arguments: id, markdown.");
    expect(textOf(await call("launch_rocket"))).toBe("Unknown tool launch_rocket");
    // undo_last über MCP: der letzte Aufruf dieses Clients
    const id = idIn(textOf(await call("create_page", { title: "Oops" })));
    expect(textOf(await call("undo_last"))).toContain("Undid create_page");
    expect(app.sync.store.blocks.has(id)).toBe(false);
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
    expect(textOf(await call("find_replace", { id: a, find: "Hallo", replace: "Servus" }))).toBe("Replaced 1 occurrence in “Alpha”");
    expect(textOf(await call("read_page", { id: a }))).toContain("Servus **Welt**, Hallo Welt");
    expect(textOf(await call("find_replace", { id: a, find: "Hallo", replace: "Grüß", all: true }))).toBe("Replaced 1 occurrence in “Alpha”");
    // nicht gefunden: Fehler, nichts geändert (so merkt der Agent es sicher)
    const miss = await call("find_replace", { id: a, find: "fehlt", replace: "x" });
    expect(miss.isError).toBe(true);
    expect(textOf(miss)).toBe("“fehlt” was not found in “Alpha”. Nothing was changed.");

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

describe("Agent-Parität 2/7: Seiten-Editor über MCP", () => {
  it("Abnahme: „verschieb den dritten Absatz in eine zweite Spalte neben das Bild und mach aus der Liste Aufgaben“ – in drei Aufrufen", async () => {
    const { app, call } = await httpClient();
    const store = app.sync.store;
    const id = idIn(textOf(await call("create_page", { title: "Trip", markdown: "First paragraph\n\n![map](https://example.com/map.png)\n\nThird paragraph\n\n- pack\n- book" })));
    let calls = 0;
    const agent = async (name: string, args: Record<string, unknown>) => { calls += 1; const r = await call(name, args); expect(r.isError, textOf(r)).toBeFalsy(); return textOf(r); };
    // 1. lesen
    const outline = await agent("read_blocks", { id });
    expect(outline.length, "eine normale Seite unter 2 000 Zeichen").toBeLessThan(2000);
    const h = (needle: string) => outline.split("\n").find((l) => l.includes(needle))!.trim().split(" ")[0]!;
    // 2. ändern
    const done = await agent("edit_blocks", { id, script: `move ${h("Third")} {right=${h("image")}}\nset ${h("pack")} {type=todo}\nset ${h("book")} {type=todo checked}` });
    expect(done).toBe("Edited “Trip”: 0 added, 2 changed, 1 moved, 0 removed.");
    // 3. prüfen
    const after = await agent("read_blocks", { id });
    expect(calls).toBe(3);
    expect(after.split("\n").map((l) => l.replace(/^(\s*)[0-9a-f]+ /, "$1"))).toEqual([
      'text "First paragraph"', "cols 2", "  col", '    image https://example.com/map.png {caption="map"}', "  col", '    text "Third paragraph"', 'todo [ ] "pack"', 'todo [x] "book"',
    ]);
    // im Store: eine Spaltenliste mit zwei Spalten, das Bild links, der Absatz rechts – und alles vom Agenten
    const list = store.children("b:" + id).map((b) => store.blocks.get(b)!).find((b) => b.type === "columnList")!;
    const cols = store.children("b:" + list.id).map((c) => store.children("b:" + c).map((k) => store.blocks.get(k)!.type));
    expect(cols).toEqual([["image"], ["text"]]);
    expect(store.blocks.get(id)?.origin).toBe("ai");
    // Berechtigungsregeln gelten für das neue Schreib-Werkzeug von selbst
    store.transact("rules", (tx) => putRecord(store, tx, AGENT_TYPE, MAIN_AGENT_ID, "Main", { ...defaultMainAgent(), permissions: { ...defaultMainAgent().permissions, rules: "deny based.edit_blocks" } }));
    const refused = await call("edit_blocks", { id, script: "text: nope" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("Not allowed by the permission rules");
    expect((await call("read_blocks", { id })).isError).toBeFalsy();
  });
});

describe("Agent-Parität: Dateien direkt in eine Seite, Bookmark mit Vorschau", () => {
  it("upload_file { page, after, caption } legt ein Bild als Block an die Stelle; ein falscher Ort ist ein Fehler", async () => {
    const { app, call } = await httpClient();
    const id = idIn(textOf(await call("create_page", { title: "Album", markdown: "First\n\nLast" })));
    const first = textOf(await call("read_blocks", { id })).split("\n")[0]!.split(" ")[0]!;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGNgYGD4z8DAwMAAAA0AAQ1Ml4gAAAAASUVORK5CYII=", "base64");
    const up = textOf(await call("upload_file", { name: "dot.png", data: png.toString("base64"), page: id, after: first, caption: 'A "dot"' }));
    expect(up).toContain("Edited “Album”: 1 added");
    const lines = textOf(await call("read_blocks", { id })).split("\n").map((l) => l.replace(/^[0-9a-f]+ /, ""));
    expect(lines[0]).toBe('text "First"');
    expect(lines[1]).toMatch(/^image "dot.png" based-asset:[0-9a-f]{64} \{caption="A \\"dot\\""\}$/);
    expect(lines[2]).toBe('text "Last"');
    const block = app.sync.store.children("b:" + id).map((b) => app.sync.store.blocks.get(b)!)[1]!;
    expect(block.props?.asset).toMatchObject({ name: "dot.png", mime: "image/png" });
    const bad = await call("upload_file", { name: "dot.png", data: png.toString("base64"), page: id, after: "zzzz" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("no block zzzz");
    expect((await call("upload_file", { name: "dot.png", data: png.toString("base64"), page: id, board: id })).isError).toBe(true);
  });

  it("ein Bookmark aus edit_blocks bekommt die Vorschau der Seite (geholt mit den Schutzregeln); scheitert das Holen, bleibt der Link", async () => {
    const { app, call } = await httpClient();
    const asked: string[] = [];
    app.pages.previews = new LinkPreviews(async (url) => {
      asked.push(url);
      if (url.includes("down")) throw new Error("no answer");
      return { bytes: Buffer.from('<html><head><title>Based Notes</title><meta name="description" content="Your data. Based."></head></html>'), mime: "text/html" };
    });
    const id = idIn(textOf(await call("create_page", { title: "Links" })));
    const out = textOf(await call("edit_blocks", { id, script: "bookmark: https://basednotes.app/\nbookmark: https://down.example/\ntext: not a bookmark https://other.example/" }));
    expect(out).toContain("3 added");
    expect(asked.sort()).toEqual(["https://basednotes.app/", "https://down.example/"]);
    const kids = app.sync.store.children("b:" + id).map((b) => app.sync.store.blocks.get(b)!);
    expect(kids[0]!.props).toMatchObject({ url: "https://basednotes.app/", bookmark: { title: "Based Notes", summary: "Your data. Based." } });
    expect(kids[1]!.props).toEqual({ url: "https://down.example/" });
  });

  it("LinkPreviews holt nie aus dem eigenen Netz", async () => {
    const real = new LinkPreviews();
    await real.prepare("bookmark: http://127.0.0.1:9/secret\nbookmark: http://169.254.169.254/latest/meta-data");
    expect(real.get("http://127.0.0.1:9/secret")).toBeUndefined();
    expect(real.get("http://169.254.169.254/latest/meta-data")).toBeUndefined();
  });
});

describe("MCP: Agent Brain (BSD-541)", () => {
  it("recall, related, about_me, remember – der Weg eines Agenten von der Frage bis zur gemerkten Tatsache", async () => {
    const { app, call, client } = await httpClient();
    expect(client.getInstructions()).toContain("Start with `recall`");
    expect(textOf(await call("based_guide", { topic: "brain" }))).toContain("remember(fact");
    expect(textOf(await call("about_me"))).toBe("Nothing saved about the user yet.");
    expect(textOf(await call("recall", { query: "" }))).toContain("Give a query");
    expect(textOf(await call("list_skills"))).toBe("No skills yet.");
    new AgentBrain(app.pages.store).saveSkill({ name: "Weekly review", description: "How to write the weekly review", body: "1. Collect done tasks.\n2. Write three lines." });
    // Der Brain existiert jetzt – „About me“ enthält nur die leere Vorlage und zählt nicht als Profil.
    expect(textOf(await call("about_me"))).toBe("Nothing saved about the user yet.");
    expect(textOf(await call("list_skills"))).toBe("- Weekly review — How to write the weekly review");
    expect(textOf(await call("load_skill", { name: "weekly review" }))).toContain("2. Write three lines.");
    expect((await call("load_skill", { name: "nope" })).isError).toBe(true);

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
      expect(textOf(r)).toContain("Created page “Über stdio”");
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
    expect(added).toMatch(/^Added row “Write docs” \(id: /);
    const rowID = idIn(added);
    expect(store.databases.get(dbID)!.properties.find((p) => p.name === "Status")!.options!.map((o) => o.name)).toContain("Doing");
    await call("add_row", { id: dbID, values: { Name: "Fix bug", Points: "8" } });

    let rows = textOf(await call("query_database", { id: dbID, sort: "Points", descending: true }));
    expect(rows.split("\n")[0]).toContain("- Fix bug (id: ");
    expect(rows).toContain(`- Write docs (id: ${rowID}) — `);
    expect(rows).toContain("Status: Doing");
    // Daten kommen so zurück, wie man sie schreibt
    expect(rows).toContain("Due: 2026-11-12");
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
    // PDF: jede Seite mit ihrem Maß (pdf.js), eine Seite je Objekt.
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /MediaBox [0 0 595 842] >>", "<< /Type /Page /Parent 2 0 R >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>"];
    let pdf = "%PDF-1.4\n";
    const offs: number[] = [];
    objs.forEach((o, i) => { offs.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const upPdf = textOf(await call("upload_file", { name: "notes.pdf", data: Buffer.from(pdf).toString("base64"), board, at: "600,0" }));
    expect(upPdf).toContain("PDF, 2 pages");
    const withPdf = textOf(await call("read_board", { id: board }));
    expect(withPdf).toMatch(/file "notes.pdf" p1 based-asset:\w+ @600,0 560x792/);
    expect(withPdf).toMatch(/file "notes.pdf" p2 based-asset:\w+ @600,808 560x560/);
    const local = await call("upload_file", { path: "/etc/hosts" });
    expect(local.isError).toBe(true);
    expect(textOf(await call("upload_file", { url: "ftp://example.com/x.png" }))).toContain("only http and https");
    expect(textOf(await call("upload_file", { url: "https://127.0.0.1/x.png" }))).toContain("not reachable");
  });
});
