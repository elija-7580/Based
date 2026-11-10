// BSD-159: der eine ChatController der App und der Haken für Tests/E2E (`globalThis.__basedChat`): eine
// ScriptedEngine statt eines echten Anbieters einsetzen – deterministisch, ohne Netz.
import { chatTitleFrom, MAIN_AGENT_ID, ScriptedEngine, type ChatEvent, type ScriptStep, type StoredChatEvent } from "@based/brain";
import type { StoreClient } from "../worker/client.js";
import { aiConfig } from "./aiConfig.js";
import { installBrain } from "../brain/setup.js";
import { ChatController } from "./controller.js";

let shared: ChatController | undefined;

/** BSD-160 / ADR 0007: jeder Chat-Turn ist ein Run (Verbrauch in €, Modell, Chat) – fürs Budget und die Übersicht. */
async function recordChatRun(client: StoreClient, t: { chatID: string; prompt: string; events: readonly StoredChatEvent[] }) {
  const usage = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
  let model: string | undefined, failed: string | undefined, result = "";
  for (const e of t.events) {
    if (e.type === "usage") {
      const u = e as Extract<ChatEvent, { type: "usage" }>;
      usage.inputTokens += u.inputTokens;
      usage.outputTokens += u.outputTokens;
      usage.costUSD += u.costUSD ?? 0;
      model ??= u.model;
    } else if (e.type === "started") model ??= (e as Extract<ChatEvent, { type: "started" }>).model;
    else if (e.type === "failed") failed = (e as Extract<ChatEvent, { type: "failed" }>).message;
    else if (e.type === "text") result = (e as Extract<ChatEvent, { type: "text" }>).text;
  }
  await client.agents({ op: "createRun", data: {
    kind: "chat", status: failed ? "failed" : "done", agentID: MAIN_AGENT_ID, title: chatTitleFrom(t.prompt) || "Chat", chatID: t.chatID, usage,
    ...(model ? { model } : {}), result: (failed ?? result).slice(0, 280),
  } });
}
const LAST_KEY = "based.chat";

function remember(id: string | undefined) {
  try {
    if (id) globalThis.localStorage?.setItem(LAST_KEY, id);
    else globalThis.localStorage?.removeItem(LAST_KEY);
  } catch {
    // nur für diese Sitzung
  }
}

/** Den zuletzt offenen Chat wieder öffnen (nach Neuladen), sobald der Store bereit ist. */
export function restoreLastChat(c: ChatController) {
  let id: string | null = null;
  try {
    id = globalThis.localStorage?.getItem(LAST_KEY) ?? null;
  } catch {
    id = null;
  }
  if (id && !c.getState().chatID) void c.open(id);
}

export function chatController(client: StoreClient): ChatController {
  if (!shared) {
    shared = new ChatController({ backend: client, config: aiConfig(), onTurnEnd: (t) => void recordChatRun(client, t).catch(() => undefined) });
    // Agent Brain: Skills, Privacy-Redact, Memories, Zitate (BSD-163/198/199).
    installBrain(client, shared);
    let last: string | undefined;
    shared.subscribe(() => {
      const id = shared!.getState().chatID;
      if (id !== last) remember((last = id));
    });
    (globalThis as { __basedChat?: unknown }).__basedChat = {
      controller: shared,
      /** Antworten nach Skript (ein Skript für jeden Turn); `delayMs` zwischen Stücken. */
      useScript(script: ScriptStep[] | ScriptStep[][], delayMs = 0) {
        const turns = Array.isArray(script[0]) ? (script as ScriptStep[][]) : [script as ScriptStep[]];
        // Je Turn eine neue Engine: der Zähler der Turns liegt deshalb hier.
        let n = 0;
        shared!.setEngineFactory((ctx) => {
          const steps = turns[Math.min(n++, turns.length - 1)]!;
          return new ScriptedEngine({ script: steps, tools: ctx.tools, policy: ctx.policy, delayMs });
        });
      },
      useModel() {
        shared!.setEngineFactory(undefined);
      },
    };
  }
  return shared;
}

const panelListeners = new Set<(open: boolean) => void>();
/** Das Chat-Panel öffnen (ChatDock hört zu). */
export function openChatPanel() {
  for (const fn of panelListeners) fn(true);
}
export function onOpenChatPanel(fn: (open: boolean) => void): () => void {
  panelListeners.add(fn);
  return () => void panelListeners.delete(fn);
}

/** Frage aus dem Composer auf Home: im Panel stellen. `false`, solange der Chat noch nicht bereit ist. */
export function askBased(text: string): boolean {
  if (!shared) return false;
  openChatPanel();
  shared.send(text);
  return true;
}
