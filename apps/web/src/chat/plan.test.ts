// BSD-245: Plan-Modus und Pfad-Regeln im Chat – gegen den echten ChatHost (Worker-Seite) auf einem In-Memory-Store.
import { createPage, MemoryPersistence, plainText, WorkspaceStore, attachSearchIndex, type JSONValue } from "@based/core";
import { Permissions, ScriptedEngine, targetPage, mainArgument, type ScriptStep, type StoredChatEvent } from "@based/brain";
import { describe, expect, it } from "vitest";
import { memoryKV, SecretStore } from "../shell/secrets.js";
import { ChatHost, type ChatLoaded, type ToolCatalog } from "../worker/chat.js";
import { AiConfig } from "./aiConfig.js";
import { ChatController, type ChatBackend, type ChatRules } from "./controller.js";

function setup(turns: ScriptStep[][], rulesText?: string) {
  const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence() });
  const search = attachSearchIndex(store);
  const host = new ChatHost(store, () => search.index);
  const call = <T>(a: Parameters<ChatHost["handle"]>[0]) => Promise.resolve(structuredClone(host.handle(a)) as T);
  const backend: ChatBackend = {
    chatList: () => call({ op: "list" }),
    chatCreate: (title) => call(title ? { op: "create", title } : { op: "create" }),
    chatLoad: (id) => call<ChatLoaded>({ op: "load", id }),
    chatSave: (id, base, events: StoredChatEvent[]) => call({ op: "save", id, base, events }),
    chatDelete: (id) => call({ op: "delete", id }),
    chatToolSpecs: () => call<ToolCatalog>({ op: "toolSpecs" }),
    chatTool: (name, input: JSONValue) => call({ op: "tool", name, input }),
  };
  const values = new Map<string, string>();
  const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v) };
  const config = new AiConfig({ storage, secrets: () => new SecretStore(memoryKV()) });
  const rules = rulesText === undefined ? undefined : async (): Promise<ChatRules> => {
    const perms = Permissions.from(rulesText);
    return async (c) => {
      const t = targetPage(c.arguments);
      const paths = t ? await call<string[]>({ op: "pagePaths", id: t }) : undefined;
      return perms.ruleVerdict({ tool: "based." + c.name, argument: mainArgument(c.arguments), paths })?.effect;
    };
  };
  const c = new ChatController({ backend, config, saveEveryMs: 1, ...(rules ? { rules } : {}) });
  let n = 0;
  c.setEngineFactory((ctx) => new ScriptedEngine({ script: turns[Math.min(n++, turns.length - 1)]!, tools: ctx.tools, policy: ctx.policy }));
  const idle = async () => {
    for (let i = 0; i < 200 && (c.getState().running || c.getState().waiting.length > 0); i++) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 5));
  };
  const titles = () => [...store.blocks.values()].filter((b) => b.type === "page").map((b) => plainText(b.text));
  return { store, c, idle, config, titles };
}

describe("Plan-Modus im Chat", () => {
  it("Schreiben wird gesammelt, „Run plan“ führt aus und kehrt in den Modus davor zurück", async () => {
    const { c, idle, config, titles } = setup([[{ text: "Plan:" }, { tool: "create_page", input: { title: "Reise" } }, { text: "1. Seite anlegen" }]]);
    config.setPermission("free");
    config.setPermission("plan");
    c.send("plane eine Reiseseite");
    await idle();
    expect(c.getState().approvals).toEqual([]);
    expect(titles()).not.toContain("Reise");
    expect(c.getState().plan?.steps).toEqual([{ name: "create_page", arguments: { title: "Reise" } }]);
    await c.runPlan();
    expect(titles()).toContain("Reise");
    expect(c.getState().plan).toBeUndefined();
    expect(config.getState().settings.permission).toBe("free");
    const notices = c.getState().events.filter((e) => e.type === "notice").map((e) => (e as { text: string }).text);
    expect(notices).toContain("Ran the plan: 1 step.");
  });

  it("Verwerfen führt nichts aus", async () => {
    const { c, idle, config, titles } = setup([[{ tool: "create_page", input: { title: "Nie" } }]]);
    config.setPermission("plan");
    c.send("x");
    await idle();
    c.dismissPlan();
    expect(c.getState().plan).toBeUndefined();
    expect(titles()).not.toContain("Nie");
    expect(config.getState().settings.permission).toBe("plan");
  });
});

describe("Pfad-Regeln im Chat", () => {
  it("deny based.*(path:Privat/**): unter „Privat“ wird nichts angelegt, anderswo schon", async () => {
    const turns: ScriptStep[][] = [];
    const { store, c, idle, config } = setup(turns, "deny based.*(path:Privat/**)");
    const privat = createPage(store, { title: "Privat" });
    const offen = createPage(store, { title: "Offen" });
    turns.push([{ tool: "create_page", input: { title: "Geheim", parent_id: privat } }, { tool: "create_page", input: { title: "Sichtbar", parent_id: offen } }]);
    config.setPermission("free");
    c.send("leg zwei Seiten an");
    await idle();
    expect(store.children("b:" + privat)).toEqual([]);
    expect(store.children("b:" + offen).map((id) => plainText(store.blocks.get(id)?.text))).toEqual(["Sichtbar"]);
    const results = c.getState().events.filter((e) => e.type === "toolResult") as { output: string; isError: boolean }[];
    expect(results.map((r) => r.isError)).toEqual([true, false]);
    expect(results[0]!.output).toBe("A permission rule blocks this action.");
  });
});
