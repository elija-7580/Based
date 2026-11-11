// BSD-159: ChatController gegen den echten ChatHost auf einem In-Memory-Store (ohne Worker, ohne DOM).
import { MemoryPersistence, WorkspaceStore, attachSearchIndex, plainText, type JSONValue } from "@based/core";
import { ScriptedEngine, type ChatMeta, type ScriptStep, type StoredChatEvent } from "@based/brain";
import { describe, expect, it } from "vitest";
import { ChatHost, type ChatLoaded, type ToolCatalog } from "../worker/chat.js";
import { AiConfig } from "./aiConfig.js";
import { ChatController, type ChatBackend } from "./controller.js";
import { memoryKV, SecretStore } from "../shell/secrets.js";

function setup(turns: ScriptStep[][]) {
  const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence() });
  const search = attachSearchIndex(store);
  const host = new ChatHost(store, () => search.index);
  const call = <T>(a: Parameters<ChatHost["handle"]>[0]) => Promise.resolve(structuredClone(host.handle(a)) as T);
  const backend: ChatBackend = {
    chatList: () => call({ op: "list" }),
    chatCreate: (title) => call(title ? { op: "create", title } : { op: "create" }),
    chatLoad: (id) => call<ChatLoaded>({ op: "load", id }),
    chatSave: (id, base, events: StoredChatEvent[], meta?: ChatMeta) => call(meta ? { op: "save", id, base, events, meta } : { op: "save", id, base, events }),
    chatDelete: (id) => call({ op: "delete", id }),
    chatToolSpecs: () => call<ToolCatalog>({ op: "toolSpecs" }),
    chatTool: (name, input: JSONValue) => call({ op: "tool", name, input }),
  };
  const c = new ChatController({ backend, saveEveryMs: 1 });
  let n = 0;
  c.setEngineFactory((ctx) => new ScriptedEngine({ script: turns[Math.min(n++, turns.length - 1)]!, tools: ctx.tools, policy: ctx.policy }));
  const idle = async () => {
    for (let i = 0; i < 200 && (c.getState().running || c.getState().waiting.length > 0); i++) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 5));
  };
  return { store, host, c, idle, backend };
}

describe("ChatController", () => {
  it("Turn mit Werkzeug und Freigabe: Seite entsteht, Transkript gespeichert, zweiter Turn hängt richtig an", async () => {
    const { store, host, c, idle } = setup([
      [{ text: "Creating." }, { tool: "create_page", input: { title: "Trip", markdown: "- a" } }, { text: "Done." }],
      [{ text: "Second." }],
    ]);
    c.send("make a trip page");
    for (let i = 0; i < 100 && c.getState().approvals.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    const [a] = c.getState().approvals;
    expect(a?.call.name).toBe("create_page");
    expect([...store.blocks.values()].some((b) => plainText(b.text) === "Trip")).toBe(false);
    c.answer(a!.call.id, true);
    await idle();
    expect([...store.blocks.values()].some((b) => plainText(b.text) === "Trip")).toBe(true);
    c.send("again");
    await idle();
    const id = c.getState().chatID!;
    const saved = host.chats.load(id);
    expect(saved.filter((e) => e.type === "userMessage").map((e) => (e as { text: string }).text)).toEqual(["make a trip page", "again"]);
    expect(saved.filter((e) => e.type === "textDelta"), "fertige Turns werden verdichtet gespeichert").toEqual([]);
    expect(saved.filter((e) => e.type === "result")).toHaveLength(2);
    expect(host.chats.get(id)?.title).toBe("make a trip page");
    // neu öffnen: gleicher Verlauf
    c.newChat();
    await c.open(id);
    expect(c.getState().events).toEqual(saved);
  });

  it("Ablehnen schreibt nichts; ohne Modell: Hinweis statt Absturz", async () => {
    const { store, c, idle } = setup([[{ tool: "create_page", input: { title: "No" } }]]);
    const before = store.blocks.size;
    c.send("x");
    for (let i = 0; i < 100 && c.getState().approvals.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    c.answer(c.getState().approvals[0]!.call.id, false);
    await idle();
    expect(store.blocks.size - before, "nur Chat + Segment").toBe(2);
    c.setEngineFactory(undefined);
    expect(c.getState().ready).toBe(false);
    c.send("y");
    await idle();
    const last = c.getState().events.at(-1);
    expect(last).toMatchObject({ type: "failed" });
  });
});

describe("AiConfig", () => {
  it("BSD-242: Low/Auto/High wählt das Modell je Aufgabe; genaue Wahl schaltet es aus; alte Einstellungen lesbar", async () => {
    const local = new Map<string, string>();
    const storage = { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v) };
    const secrets = new SecretStore(memoryKV());
    const cfg = new AiConfig({ storage, secrets: () => secrets });
    cfg.setProvider("anthropic", { models: ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1"] });
    await cfg.setKey("anthropic", "sk-x");
    cfg.setModel("anthropic/claude-sonnet-4-5");
    expect(cfg.modelFor({ text: "hi" }).choice?.ref).toBe("anthropic/claude-sonnet-4-5"); // ohne Stufe: gewähltes Modell
    cfg.setCompute("low");
    const low = cfg.modelFor({ text: "Tell me something about the history of cats" });
    expect(low.route?.level).toBe("low");
    expect(low.choice?.ref).toBe("anthropic/claude-haiku-4-5");
    cfg.setCompute("high");
    expect(cfg.modelFor({ text: "Tell me something about the history of cats" }).choice?.ref).toBe("anthropic/claude-opus-4-1");
    // Code-Aufgabe: auch bei Low mindestens das mittlere Modell (Route „code“)
    cfg.setCompute("low");
    expect(cfg.modelFor({ text: "Fix the failing test in src/app.ts" }).choice?.ref).toBe("anthropic/claude-sonnet-4-5");
    cfg.setCompute("high");
    // übersteht Neuladen
    const again = new AiConfig({ storage, secrets: () => secrets });
    await again.load();
    expect(again.getState().settings.compute).toBe("high");
    // genaue Wahl gewinnt
    again.setModel("anthropic/claude-sonnet-4-5");
    expect(again.getState().settings.compute).toBeUndefined();
    expect(again.modelFor({ text: "x" }).route).toBeUndefined();
  });

  it("Schlüssel nur verschlüsselt, Modelle frei eintragbar, aktives Modell", async () => {
    const kv = memoryKV();
    const local = new Map<string, string>();
    const storage = { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v) };
    const secrets = new SecretStore(kv);
    const cfg = new AiConfig({ storage, secrets: () => secrets });
    expect(cfg.activeModel()).toBeUndefined();
    cfg.setProvider("anthropic", { models: ["model-x"] });
    expect(cfg.models()).toEqual([{ ref: "anthropic/model-x", kind: "anthropic", model: "model-x", usable: false }]);
    await cfg.setKey("anthropic", "sk-secret-value");
    expect(cfg.activeModel()?.ref).toBe("anthropic/model-x");
    expect([...local.values()].join()).not.toContain("sk-secret-value");
    expect(JSON.stringify([...kv.map.entries()].map(([k, v]) => [k, v instanceof Object && "data" in v ? "sealed" : v]))).not.toContain("sk-secret-value");
    expect(await cfg.key("anthropic")).toBe("sk-secret-value");
    cfg.setProvider("ollama", { models: ["llama"] });
    cfg.setModel("ollama/llama");
    expect(cfg.activeModel()?.ref).toBe("ollama/llama");
    const again = new AiConfig({ storage, secrets: () => secrets });
    await again.load();
    expect(again.getState().hasKey.anthropic).toBe(true);
    expect(again.activeModel()?.ref).toBe("ollama/llama");
    // kein Netz beim Bauen des Anbieters
    const calls: string[] = [];
    const p = await again.provider(again.activeModel()!, (async (u: string) => { calls.push(u); return new Response(""); }) as typeof fetch);
    expect(p.id).toBe("ollama");
    expect(calls).toEqual([]);
    await again.setKey("anthropic", undefined);
    expect(await again.key("anthropic")).toBeUndefined();
  });

  it("BSD-257: ChatGPT über Codex – alte Einstellungen lesbar, nur mit Server nutzbar, Engine statt Anbieter", async () => {
    const local = new Map<string, string>();
    // Stand vor BSD-257: ohne „chatgpt“-Eintrag
    local.set("based.ai", JSON.stringify({ v: 1, providers: { anthropic: { baseURL: "https://api.anthropic.com", models: ["m"] } }, model: "anthropic/m", permission: "free" }));
    const storage = { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v) };
    const secrets = new SecretStore(memoryKV());
    const conn: { server?: { url: string; token: string } } = {};
    const cfg = new AiConfig({ storage, secrets: () => secrets, server: () => conn.server });
    expect(cfg.getState().settings.permission).toBe("free");
    expect(cfg.getState().settings.providers.chatgpt.models).toEqual([]);
    cfg.setChatGPT(true);
    expect(cfg.models().filter((m) => m.kind === "chatgpt")).toEqual([
      { ref: "chatgpt/auto", kind: "chatgpt", model: "auto", usable: false },
      { ref: "chatgpt/low", kind: "chatgpt", model: "low", usable: false },
      { ref: "chatgpt/high", kind: "chatgpt", model: "high", usable: false },
    ]);
    conn.server = { url: "http://127.0.0.1:1", token: "t" };
    expect(cfg.activeModel()?.ref).toBe("chatgpt/auto");
    await expect(cfg.provider(cfg.activeModel()!)).rejects.toThrow(/Codex/);
    const calls: string[] = [];
    const e = await cfg.engine(cfg.models().find((m) => m.ref === "chatgpt/high")!, { fetch: (async (u: string) => { calls.push(u); return new Response(""); }) as typeof fetch });
    expect(e.label).toBe("ChatGPT (Codex, high)");
    expect(calls).toEqual([]);
    // unbekannte Stufen fallen beim Laden weg
    local.set("based.ai", JSON.stringify({ v: 1, providers: { chatgpt: { baseURL: "", models: ["auto", "gpt-9"] } }, permission: "ask" }));
    expect(new AiConfig({ storage, secrets: () => secrets }).getState().settings.providers.chatgpt.models).toEqual(["auto"]);
    cfg.setChatGPT(false);
    expect(cfg.models().some((m) => m.kind === "chatgpt")).toBe(false);
  });
});
