// BSD-222: MCP-Laufzeit im Hauptthread gegen die echten Worker-Ops (AgentHost) und einen Fake-MCP-Server über fetch
// (Streamable HTTP mit JSON-Antworten): Token aus der verschlüsselten Ablage, nie im Record; Werkzeuge erst nach dem
// Verbinden; Ausschalten/Entfernen trennt; neues Token verbindet neu.
import { MemoryPersistence, WorkspaceStore } from "@based/core";
import { describe, expect, it } from "vitest";
import { memoryKV, SecretStore } from "../shell/secrets.js";
import { AgentHost, type AgentAction } from "../worker/agents.js";
import { McpRuntime, type ConnectionsBackend } from "./mcp.js";

/** Minimaler MCP-Server als fetch: initialize, tools/list, tools/call; verlangt `Bearer good`. */
function fakeMcp() {
  const calls: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== "Bearer good") return new Response("unauthorized", { status: 401 });
    if ((init?.method ?? "GET") !== "POST") return new Response(null, { status: 405 });
    const msg = JSON.parse(String(init!.body)) as { id?: number; method: string; params?: { name?: string; arguments?: { title?: string } } };
    calls.push(msg.method);
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { headers: { "Content-Type": "application/json" } });
    switch (msg.method) {
      case "initialize": return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
      case "tools/list": return reply({ tools: [
        { name: "list_issues", description: "List", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        { name: "create_issue", description: "Create", inputSchema: { type: "object", properties: { title: { type: "string" } } } },
      ] });
      case "tools/call": return reply({ content: [{ type: "text", text: `${msg.params?.name}:${msg.params?.arguments?.title ?? ""}` }] });
      default: return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } }), { headers: { "Content-Type": "application/json" } });
    }
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function setup() {
  const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence() });
  const host = new AgentHost(store);
  const backend: ConnectionsBackend = { agents: <T>(a: AgentAction) => Promise.resolve(structuredClone(host.handle(a)) as T) } as ConnectionsBackend;
  const secrets = new SecretStore(memoryKV());
  const mcp = fakeMcp();
  const rt = new McpRuntime(backend, () => secrets, mcp.fetch);
  return { store, rt, secrets, mcp };
}

describe("McpRuntime", () => {
  it("eigener Server mit Token: verbindet, Werkzeuge im Chat-Host, Token nur verschlüsselt", async () => {
    const { store, rt, secrets } = setup();
    const c = await rt.add({ name: "Tracker", transport: "http", url: "https://mcp.example/mcp" }, "good");
    await rt.ready();
    expect(rt.getState().status[c.id]).toMatchObject({ status: "ready", tools: 2, server: "fake" });
    const host = rt.tools()!;
    expect(host.specs.map((s) => s.name)).toEqual(["mcp__tracker__list_issues", "mcp__tracker__create_issue"]);
    expect(host.isWrite("mcp__tracker__create_issue")).toBe(true);
    expect(await host.call("mcp__tracker__create_issue", { title: "A" })).toEqual({ text: "create_issue:A", isError: false });
    expect(await secrets.getSecret(c.data.secretRef!)).toBe("good");
    expect(JSON.stringify(store.allRecords())).not.toContain("good");
  });

  it("falsches Token: Fehler im Zustand, keine Werkzeuge; neues Token verbindet neu", async () => {
    const { rt } = setup();
    const c = await rt.add({ name: "Tracker", transport: "http", url: "https://mcp.example/mcp" }, "bad");
    await rt.ready();
    expect(rt.getState().status[c.id]!.status).toBe("failed");
    expect(rt.getState().status[c.id]!.error).not.toContain("bad");
    expect(rt.tools()).toBeUndefined();
    await rt.update(c.id, {}, "good");
    await rt.ready();
    expect(rt.getState().status[c.id]!.status).toBe("ready");
    expect(rt.tools()?.specs).toHaveLength(2);
  });

  it("aus, nicht für Agenten, entfernen", async () => {
    const { rt, secrets } = setup();
    const c = await rt.add({ name: "Tracker", transport: "http", url: "https://mcp.example/mcp" }, "good");
    await rt.ready();
    await rt.update(c.id, { exposeToAgents: false });
    const agent = { v: 1 as const, kind: "main" as const, permissions: { mode: "ask" as const, rules: "" } };
    expect(rt.tools({ agent })).toBeUndefined();
    expect(rt.tools()?.specs).toHaveLength(2);
    await rt.update(c.id, { enabled: false });
    expect(rt.getState().status[c.id]!.status).toBe("disabled");
    expect(rt.tools()).toBeUndefined();
    await rt.remove(c.id);
    expect(rt.getState().connections).toEqual([]);
    expect(await secrets.getSecret(c.data.secretRef!)).toBeUndefined();
  });
});
