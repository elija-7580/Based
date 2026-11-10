// BSD-222: MCP-Connections – Client gegen einen Test-Server (In-Memory und Streamable HTTP mit Token),
// Werkzeuge als ToolHost im Chat mit Freigabe nach Berechtigungsmodus, Records ohne Geheimnis.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MemoryPersistence, WorkspaceStore } from "@based/core";
import { combineToolHosts, ModelEngine, runTurn, type ChatEvent, type ToolHost } from "../src/index.js";
import {
  addConnection, catalogEntry, catalogUsable, connectionFromCatalog, connectionsFor, connectionSlug, getConnection, httpTransport, listConnections,
  McpConnection, McpToolHost, MCP_CATALOG, removeConnection, secretRefFor, toolResultText, updateConnection, validateConnection,
} from "../src/mcp/index.js";
import { collect, ScriptedProvider } from "./helpers.js";

/** Test-Server: ein lesendes und ein schreibendes Werkzeug, eines mit Fehler, eines mit Bild. */
function testServer() {
  const issues: string[] = [];
  const server = new McpServer({ name: "test-tracker", version: "1.0.0" });
  server.registerTool("search_issues", {
    description: "Search issues",
    inputSchema: { query: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => ({ content: [{ type: "text", text: `found: ${issues.filter((i) => i.includes(query)).join(", ") || "nothing"}` }] }));
  server.registerTool("create_issue", {
    description: "Create an issue",
    inputSchema: { title: z.string() },
  }, async ({ title }) => {
    issues.push(title);
    return { content: [{ type: "text", text: `created #${issues.length}` }] };
  });
  server.registerTool("broken", { description: "Always fails" }, async () => ({ content: [{ type: "text", text: "boom" }], isError: true }));
  server.registerTool("chart", { description: "Returns an image", annotations: { readOnlyHint: true } }, async () => ({
    content: [{ type: "text", text: "chart:" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
  }));
  return { server, issues };
}

async function inMemory(name = "Tracker") {
  const t = testServer();
  const [client, srv] = InMemoryTransport.createLinkedPair();
  await t.server.connect(srv);
  const c = new McpConnection(name, () => client);
  await c.connect();
  return { c, ...t };
}

const never = new AbortController().signal;
let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
});

/** Streamable-HTTP-Server mit Bearer-Token (zustandslos: je Anfrage ein Transport). */
async function httpServer(token: string): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const http = createServer(async (req, res) => {
    seen.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const { server } = testServer();
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  servers.push(http);
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, seen };
}

describe("McpConnection", () => {
  it("verbindet, listet Werkzeuge mit Lese-/Schreib-Hinweis und ruft sie auf", async () => {
    const { c, issues } = await inMemory();
    expect(c.status).toBe("ready");
    expect(c.serverName).toBe("test-tracker");
    expect(c.tools.map((t) => [t.name, t.readOnly])).toEqual([["search_issues", true], ["create_issue", false], ["broken", false], ["chart", true]]);
    expect(await c.call("create_issue", { title: "Bug A" })).toEqual({ text: "created #1", isError: false });
    expect(issues).toEqual(["Bug A"]);
    expect(await c.call("search_issues", { query: "Bug" })).toEqual({ text: "found: Bug A", isError: false });
    expect(await c.call("broken", {})).toEqual({ text: "boom", isError: true });
    expect(await c.call("chart", {})).toEqual({ text: "chart:\n[image image/png]", isError: false });
    // Unbekanntes Werkzeug / falsche Argumente: Fehler als Ergebnis, kein Wurf.
    expect((await c.call("nope", {})).isError).toBe(true);
    expect((await c.call("create_issue", { title: 5 })).isError).toBe(true);
    await c.close();
    expect(c.status).toBe("closed");
  });

  it("Streamable HTTP mit Token im Header; falsches Token: Fehler ohne Token in der Meldung", async () => {
    const { url, seen } = await httpServer("s3cret-token");
    const ok = new McpConnection("Tracker", () => httpTransport(url, { token: "s3cret-token" }));
    await ok.connect();
    expect(ok.tools).toHaveLength(4);
    expect(await ok.call("create_issue", { title: "über HTTP" })).toEqual({ text: "created #1", isError: false });
    expect(seen.every((h) => h === "Bearer s3cret-token")).toBe(true);
    await ok.close();

    const bad = new McpConnection("Tracker", () => httpTransport(url, { token: "wrong-token-xyz" }));
    await expect(bad.connect()).rejects.toThrow(/Tracker/);
    expect(bad.status).toBe("failed");
    expect(bad.lastError).toBeTruthy();
    expect(bad.lastError).not.toContain("wrong-token-xyz");
    expect((await bad.call("search_issues", { query: "x" })).isError).toBe(true);
  });

  it("toolResultText: Ressourcen, Links, strukturierte Inhalte", () => {
    expect(toolResultText({ content: [{ type: "resource", resource: { uri: "file:///a", text: "inhalt" } }, { type: "resource", resource: { uri: "file:///b" } }] })).toBe("inhalt\nfile:///b");
    expect(toolResultText({ content: [{ type: "resource_link", uri: "https://x/1", name: "Issue 1" }] })).toBe("Issue 1: https://x/1");
    expect(toolResultText({ content: [], structuredContent: { n: 1 } })).toBe('{"n":1}');
  });
});

describe("McpToolHost", () => {
  it("Namen mcp__<connection>__<tool>, eindeutig und API-tauglich; Aufruf landet beim richtigen Server", async () => {
    const a = await inMemory("GitHub (work)");
    const b = await inMemory("GitHub (work)");
    const h = new McpToolHost([a.c, b.c]);
    const names = h.specs.map((s) => s.name);
    expect(names).toContain("mcp__github_work__create_issue");
    expect(names).toContain("mcp__github_work_2__create_issue");
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(h.specs.find((s) => s.name === "mcp__github_work__search_issues")!.description).toBe("[GitHub (work)] Search issues");
    expect(h.isWrite("mcp__github_work__create_issue")).toBe(true);
    expect(h.isWrite("mcp__github_work__search_issues")).toBe(false);
    expect(h.origin("mcp__github_work_2__chart")).toEqual({ connection: "GitHub (work)", tool: "chart" });
    await h.call("mcp__github_work_2__create_issue", { title: "nur B" });
    expect(a.issues).toEqual([]);
    expect(b.issues).toEqual(["nur B"]);
    expect((await h.call("mcp__unbekannt__x", {})).isError).toBe(true);
    expect(connectionSlug("Ünïcode Server!! mit sehr langem Namen")).toBe("unicode_server_mit_s");
  });

  it("im Chat: lesendes Werkzeug läuft frei, schreibendes fragt bei „Ask before edits“ – abgelehnt passiert nichts", async () => {
    const { c, issues } = await inMemory("Tracker");
    const workspace: ToolHost = { specs: [{ name: "search", description: "s", inputSchema: {} }], isWrite: () => false, call: async () => ({ text: "ws", isError: false }) };
    const tools = combineToolHosts(workspace, new McpToolHost([c]));
    const asked: string[] = [];
    const run = async (approve: boolean) => {
      const p = new ScriptedProvider([
        { text: "", calls: [{ id: "r1", name: "mcp__tracker__search_issues", arguments: { query: "x" } }, { id: "w1", name: "mcp__tracker__create_issue", arguments: { title: "Neu" } }], stop: "tool_use" },
        { text: "Fertig.", stop: "end_turn" },
      ]);
      const engine = new ModelEngine({ provider: p, model: "m", tools, policy: { mode: "askEdits", approve: async (call) => { asked.push(call.name); return approve; } } });
      const events = await collect(runTurn(engine, { prompt: "leg ein Issue an" }, never));
      expect(p.seenOptions[0]!.tools.map((t) => t.name)).toEqual(["search", "mcp__tracker__search_issues", "mcp__tracker__create_issue", "mcp__tracker__broken", "mcp__tracker__chart"]);
      return events.filter((e): e is Extract<ChatEvent, { type: "toolResult" }> => e.type === "toolResult");
    };
    const declined = await run(false);
    expect(asked).toEqual(["mcp__tracker__create_issue"]);
    expect(issues).toEqual([]);
    expect(declined.map((r) => r.isError)).toEqual([false, true]);
    const approved = await run(true);
    expect(issues).toEqual(["Neu"]);
    expect(approved.map((r) => r.isError)).toEqual([false, false]);
  });
});

describe("Connections als Records", () => {
  const store = () => new WorkspaceStore({ persistence: new MemoryPersistence([]), node: "t" });

  it("anlegen, ändern, entfernen; das Geheimnis steht nie im Record", () => {
    const s = store();
    const gh = addConnection(s, connectionFromCatalog(catalogEntry("github")!));
    expect(gh.name).toBe("GitHub");
    expect(gh.data).toMatchObject({ transport: "http", url: "https://api.githubcopilot.com/mcp/", enabled: true, exposeToAgents: true, catalogID: "github", secretRef: secretRefFor(gh.id) });
    const own = addConnection(s, { name: "Mein Server", transport: "http", url: "http://localhost:3000/mcp" });
    expect(own.data.secretRef).toBeUndefined();
    expect(listConnections(s).map((c) => c.name)).toEqual(["GitHub", "Mein Server"]);
    updateConnection(s, own.id, { enabled: false, name: "Lokal", withSecret: true, headerName: "X-Api-Key" });
    expect(getConnection(s, own.id)).toMatchObject({ name: "Lokal", data: { enabled: false, secretRef: secretRefFor(own.id), headerName: "X-Api-Key" } });
    expect(JSON.stringify(s.allRecords())).not.toMatch(/token|Bearer/i);
    removeConnection(s, own.id);
    expect(listConnections(s).map((c) => c.id)).toEqual([gh.id]);
    expect(() => addConnection(s, { name: "x", transport: "http", url: "http://evil.example/mcp" })).toThrow(/https/);
  });

  it("Prüfung von URL und Befehl", () => {
    expect(validateConnection({ name: "", transport: "http", url: "https://a" })).toMatch(/name/);
    expect(validateConnection({ name: "a", transport: "http", url: "kein url" })).toMatch(/URL/);
    expect(validateConnection({ name: "a", transport: "http", url: "https://user:pw@a.example/mcp" })).toMatch(/token field/);
    expect(validateConnection({ name: "a", transport: "http", url: "https://a.example/mcp" })).toBeUndefined();
    expect(validateConnection({ name: "a", transport: "stdio", command: " " })).toMatch(/command/);
  });

  it("welche Connections ein Lauf nutzen darf (Chat, Agent, Projekt)", () => {
    const s = store();
    const a = addConnection(s, { name: "A", transport: "http", url: "https://a.example/mcp" });
    const b = addConnection(s, { name: "B", transport: "http", url: "https://b.example/mcp", exposeToAgents: false });
    const c = addConnection(s, { name: "C", transport: "http", url: "https://c.example/mcp" });
    updateConnection(s, c.id, { enabled: false });
    const all = listConnections(s);
    expect(connectionsFor(all).map((x) => x.name)).toEqual(["A", "B"]);
    const agent = { v: 1 as const, kind: "agent" as const, permissions: { mode: "ask" as const, rules: "" } };
    expect(connectionsFor(all, { agent }).map((x) => x.name)).toEqual(["A"]);
    expect(connectionsFor(all, { agent: { ...agent, connections: [b.id] } }).map((x) => x.name)).toEqual([]);
    expect(connectionsFor(all, { agent, project: { v: 1, status: "active", createdAt: 0, connections: [] } })).toEqual([]);
    expect(connectionsFor(all, { agent: { ...agent, connections: [a.id] }, project: { v: 1, status: "active", createdAt: 0 } }).map((x) => x.id)).toEqual([a.id]);
  });

  it("Katalog: IDs eindeutig, HTTP-Einträge mit https, OAuth-Einträge (noch) nicht verbindbar", () => {
    expect(new Set(MCP_CATALOG.map((e) => e.id)).size).toBe(MCP_CATALOG.length);
    for (const e of MCP_CATALOG) if (e.url) expect(e.url).toMatch(/^https:\/\//);
    expect(catalogUsable(catalogEntry("github")!, { stdio: false })).toBe(true);
    expect(catalogUsable(catalogEntry("notion")!, { stdio: false })).toBe(false);
    expect(catalogUsable(catalogEntry("filesystem")!, { stdio: false })).toBe(false);
    expect(catalogUsable(catalogEntry("filesystem")!, { stdio: true })).toBe(true);
  });
});
