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
  it("BSD-408: ⇧Tab schnell hintereinander – eine ältere Antwort setzt den Modus nicht zurück", async () => {
    const modes = [{ id: "default", name: "Default" }, { id: "acceptEdits", name: "Accept edits" }, { id: "plan", name: "Plan" }];
    let serverMode = "default";
    const view = () => ({ ...session, state: "idle", modes, agentMode: serverMode });
    const later = <T,>(ms: number, v: () => T) => new Promise<T>((res) => setTimeout(() => res(v()), ms));
    const json = (v: unknown) => new Response(JSON.stringify(v));
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const key = `${init?.method ?? "GET"} ${u.pathname}`;
      if (key === "GET /coding/agents") return json({ agents: [] });
      if (key === "GET /coding/sessions") return json({ sessions: [view()] });
      if (key === "GET /coding/inbox") return later(20, () => json({ version: 0, items: [] }));
      if (key === "GET /coding/sessions/cs-1/events") {
        const snap = view(); // Stand bei Anfrage, die Antwort kommt später (Long-Poll)
        return later(15, () => json({ events: [], next: 0, state: "idle", session: snap }));
      }
      if (key === "POST /coding/sessions/cs-1/agent-mode") {
        const mode = (JSON.parse(String(init!.body)) as { mode: string }).mode;
        serverMode = mode; // der Server übernimmt sofort, die Antwort auf die erste Anfrage kommt zuletzt
        const answer = view();
        return later(mode === "acceptEdits" ? 40 : 5, () => json(answer));
      }
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch;
    const m = new CodingModel({ url: "http://s", token: "t", fetch }, 5);
    await m.start();
    m.select("cs-1");
    const mode = () => m.getState().sessions.find((x) => x.id === "cs-1")?.agentMode;
    await vi.waitFor(() => expect(mode()).toBe("default"));
    const a = m.setAgentMode("acceptEdits");
    expect(mode()).toBe("acceptEdits");
    const b = m.setAgentMode("plan");
    expect(mode()).toBe("plan");
    await Promise.all([a, b]);
    // die langsame Antwort auf „acceptEdits“ und die Long-Polls dazwischen ändern nichts mehr
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 10));
      expect(mode()).toBe("plan");
    }
    m.stop();
  });
});
