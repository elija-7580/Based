// Agent Brain im Chat: ChatController + echter ChatHost/BrainHost auf einem In-Memory-Store (ohne Worker, ohne DOM).
import { createPage, MemoryPersistence, WorkspaceStore, attachSearchIndex, type JSONValue } from "@based/core";
import { ScriptedEngine, WorkspaceTools, type ChatMeta, type StoredChatEvent } from "@based/brain";
import { beforeEach, describe, expect, it } from "vitest";
import { ChatController, type ChatBackend } from "../chat/controller.js";
import { BrainHost } from "../worker/brain.js";
import { ChatHost, type ChatLoaded, type ToolCatalog } from "../worker/chat.js";
import type { StoreClient } from "../worker/client.js";
import { BrainClient } from "./client.js";
import { BrainChat } from "./runtime.js";
import { BrainSettingsStore } from "./settings.js";

// localStorage für die Einstellungen (Node hat keins).
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k),
};

function setup() {
  const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence() });
  const search = attachSearchIndex(store);
  const chat = new ChatHost(store, () => search.index);
  const brainHost = new BrainHost(store);
  store.observe((ch) => brainHost.noteChange(ch));
  const call = <T>(a: Parameters<ChatHost["handle"]>[0]) => Promise.resolve(structuredClone(chat.handle(a)) as T);
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
  const engines: ScriptedEngine[] = [];
  c.setEngineFactory((ctx) => {
    const e = new ScriptedEngine({ script: (req) => [{ text: `Noted: ${req.prompt}` }], tools: ctx.tools, policy: ctx.policy });
    engines.push(e);
    return e;
  });
  const request = (<T>(req: { type: string; action: unknown }) => Promise.resolve(structuredClone(brainHost.handle(req.action as never)) as T)) as StoreClient["request"];
  const settings = new BrainSettingsStore();
  const brain = new BrainChat(new BrainClient({ request }), c, settings, 0);
  brain.install();
  const idle = async () => {
    await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 300 && (c.getState().running || c.getState().waiting.length > 0); i++) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 20));
  };
  const saved = () => chat.chats.load(c.getState().chatID!);
  return { store, chat, brainHost, c, brain, settings, engines, idle, saved };
}

const send = (brain: BrainChat, c: ChatController, text: string) => {
  brain.captureSend(text);
  c.send(text);
  brain.setDraft("");
};

beforeEach(() => mem.clear());

describe("Agent Brain in the chat", () => {
  it("skill chips: routed while typing, swappable; the swapped skill goes into the system prompt and is recorded", async () => {
    const { brainHost, c, brain, settings, engines, idle, saved } = setup();
    brainHost.brain.saveSkill({ name: "weekly-review", description: "Reflect on the past week and plan priorities for next week.", body: "List wins. Pick three priorities." });
    brainHost.brain.saveSkill({ name: "weekly-newsletter", description: "Write the weekly newsletter email for subscribers.", body: "Greeting, links, sign-off." });
    brain.setDraft("Help me do my weekly review and plan priorities");
    await new Promise((r) => setTimeout(r, 10));
    expect(brain.getState().chips.map((x) => x.name)).toEqual(["weekly-review"]);
    const alt = brain.alternatives().find((a) => a.name === "weekly-newsletter")!;
    brain.swapChip(brain.getState().chips[0]!.id, alt);
    expect(brain.getState().chips.map((x) => x.name)).toEqual(["weekly-newsletter"]);
    send(brain, c, "Help me do my weekly review and plan priorities");
    expect(brain.getState().chips).toEqual([]);
    await idle();
    const sys = engines[0]!.requests[0]!.system!;
    expect(sys).toContain("## Skill: weekly-newsletter");
    expect(sys).toContain("Greeting, links, sign-off.");
    expect(sys).not.toContain("## Skill: weekly-review");
    expect(sys).toContain("[[block:");
    const ev = saved().find((e) => e.type === "skills") as unknown as { skills: { name: string }[]; corrected?: boolean };
    expect(ev.skills.map((s) => s.name)).toEqual(["weekly-newsletter"]);
    expect(ev.corrected).toBe(true);
    expect(settings.corrections()).toMatchObject([{ query: "Help me do my weekly review and plan priorities", added: [alt.id] }]);
    expect(settings.corrections()[0]!.removed).toHaveLength(1);
  });

  it("redact: the engine only sees placeholders, the answer shows real values, the turn records the count", async () => {
    const { c, brain, settings, engines, idle, saved } = setup();
    settings.update((s) => ({ ...s, redact: { ...s.redact, enabled: true, names: ["Anna Schmidt"] } }));
    send(brain, c, "Mail Anna Schmidt at anna@example.org about IBAN DE89 3704 0044 0532 0130 00");
    await idle();
    expect(engines[0]!.requests[0]!.prompt).toBe("Mail <PERSON_1> at <EMAIL_1> about IBAN <IBAN_1>");
    const events = saved();
    const text = events.find((e) => e.type === "text") as { text: string };
    expect(text.text).toBe("Noted: Mail Anna Schmidt at anna@example.org about IBAN DE89 3704 0044 0532 0130 00");
    expect(events.find((e) => e.type === "redaction")).toMatchObject({ count: 3, kinds: { PERSON: 1, EMAIL: 1, IBAN: 1 } });
    // Zweiter Turn: der Verlauf wird ebenfalls geschwärzt, dieselben Platzhalter.
    send(brain, c, "And again anna@example.org");
    await idle();
    const req = engines[1]!.requests[0]!;
    expect(req.prompt).toBe("And again <EMAIL_1>");
    expect(JSON.stringify(req.history)).not.toContain("anna@example.org");
  });

  it("redact once from the paste hint, not for local models, warning for CLI engines", async () => {
    const { c, brain, engines, idle } = setup();
    brain.setDraft("Call +49 30 1234567");
    expect(brain.getState().sensitive).toHaveLength(1);
    brain.setRedactOnce(true);
    send(brain, c, "Call +49 30 1234567");
    await idle();
    expect(engines[0]!.requests[0]!.prompt).toBe("Call <PHONE_1>");
    send(brain, c, "Call +49 30 1234567 again");
    await idle();
    expect(engines[1]!.requests[0]!.prompt).toBe("Call +49 30 1234567 again");
  });

  it("memory suggestions are only saved after confirmation", async () => {
    const { brainHost, c, brain, settings, idle, saved } = setup();
    settings.update((s) => ({ ...s, memories: { suggest: true } }));
    brain.extractor = async () => JSON.stringify({ memories: [{ title: "Coffee", type: "Preference", body: "Drinks espresso, no sugar." }, { title: "Salary", type: "Profile", body: "Earns a lot." }] });
    send(brain, c, "I always drink espresso without sugar, by the way.");
    await idle();
    const suggestions = saved().filter((e) => e.type === "memorySuggestion") as unknown as { id: string; suggestion: { title: string; sensitive: boolean } }[];
    expect(suggestions.map((s) => [s.suggestion.title, s.suggestion.sensitive])).toEqual([["Coffee", false], ["Salary", true]]);
    expect(brainHost.brain.memories()).toEqual([]);
    const { memorySuggestionsOf } = await import("@based/brain");
    const pending = memorySuggestionsOf(c.getState().events);
    await brain.saveMemory(pending[0]!);
    await brain.dismissMemory(pending[1]!);
    expect(brainHost.brain.memories().map((m) => [m.title, m.kind, m.body])).toEqual([["Coffee", "Preference", "Drinks espresso, no sugar."]]);
    expect(memorySuggestionsOf(saved()).map((p) => p.state)).toEqual(["saved", "dismissed"]);
  });

  it("short messages produce no memory call", async () => {
    const { c, brain, settings, idle, saved } = setup();
    settings.update((s) => ({ ...s, memories: { suggest: true } }));
    let called = 0;
    brain.extractor = async () => { called += 1; return "{}"; };
    send(brain, c, "thanks");
    await idle();
    expect(called).toBe(0);
    expect(saved().some((e) => e.type === "memorySuggestion")).toBe(false);
  });

  it("citations resolve to page, block and snippet; brain tools are offered to the engine", async () => {
    const { store, brainHost } = setup();
    const page = createPage(store, { title: "Budget" });
    new WorkspaceTools(store).callSync("append_markdown", { page_id: page, markdown: "The budget is 5k." });
    const block = store.children("b:" + page)[0]!;
    const r = brainHost.handle({ op: "resolveCitations", markers: [{ kind: "block", id: block }, { kind: "block", id: "nope" }] }) as Record<string, unknown>;
    expect(r[`block:${block}`]).toEqual({ pageID: page, blockID: block, title: "Budget", snippet: "The budget is 5k." });
    expect(r["block:nope"]).toBeNull();
    const tool = brainHost.handle({ op: "tool", name: "read_page_blocks", input: { page_id: page } }) as { text: string };
    expect(tool.text).toContain(`[block:${block}]`);
    expect((brainHost.handle({ op: "related", pageID: page }) as unknown[]).length).toBe(0);
  });

  it("the Agent Brain can't be trashed through the host guard and repairs itself", async () => {
    const { store, brainHost } = setup();
    const ids = brainHost.brain.ensure();
    expect(brainHost.guardDelete([ids.root]).allowed).toEqual([]);
    const { trashPages } = await import("@based/core");
    trashPages(store, [ids.about]);
    await new Promise((r) => setTimeout(r, 5));
    expect(store.blocks.get(ids.about)!.trashedAt).toBeUndefined();
  });
});
