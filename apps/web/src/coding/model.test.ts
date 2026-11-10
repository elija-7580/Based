// BSD-223: Zustand der Coding-Ansicht gegen einen Fake-Server (fetch).
import { describe, expect, it, vi } from "vitest";
import { CodingModel } from "./model.js";

function fakeServer(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    calls.push(key + u.search);
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const r = h(init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const session = { id: "cs-1", agentId: "fake", agentName: "Fake", cwd: "/w", state: "idle", acpSessionId: "s1", mode: "askEdits", modes: [], createdAt: 0, eventCount: 0, error: undefined, handoffFrom: undefined };

describe("CodingModel", () => {
  it("lädt Agenten und Sitzungen, öffnet eine Sitzung, sendet und faltet Ereignisse", async () => {
    const { fetch, calls } = fakeServer({
      "GET /coding/agents": () => ({ json: { agents: [{ id: "fake", name: "Fake", icon: "", note: "" }] } }),
      "GET /coding/sessions": () => ({ json: { sessions: [session] } }),
      "GET /coding/inbox": () => ({ json: { version: 0, items: [] } }),
      "GET /coding/sessions/cs-1/events": () => ({ json: { events: [{ type: "userMessage", text: "hi" }, { type: "text", text: "yo" }, { type: "result", text: "yo", isError: false }], next: 3, state: "closed" } }),
      "POST /coding/sessions/cs-1/prompt": () => ({ status: 202, json: { ok: true } }),
    });
    const m = new CodingModel({ url: "http://s", token: "t", fetch }, 10);
    await m.start();
    expect(m.getState()).toMatchObject({ loading: false, error: undefined });
    expect(m.getState().agents.map((a) => a.id)).toEqual(["fake"]);
    m.select("cs-1");
    await vi.waitFor(() => expect(m.getState().items.map((i) => i.kind)).toEqual(["user", "assistant"]));
    expect(await m.send("again")).toBe(true);
    expect(calls).toContain("POST /coding/sessions/cs-1/prompt");
    m.stop();
  });

  it("Server ohne Coding-Agenten: verständlicher Fehler statt Absturz", async () => {
    const { fetch } = fakeServer({});
    const m = new CodingModel({ url: "http://s", token: "t", fetch }, 10);
    await m.start();
    expect(m.getState().error).toMatch(/--coding-root/);
    expect(await m.send("x")).toBe(false);
  });
});
