// BSD-159: der eine ChatController der App und der Haken für Tests/E2E (`globalThis.__basedChat`): eine
// ScriptedEngine statt eines echten Anbieters einsetzen – deterministisch, ohne Netz.
import { ScriptedEngine, type ScriptStep } from "@based/brain";
import type { StoreClient } from "../worker/client.js";
import { aiConfig } from "./aiConfig.js";
import { installBrain } from "../brain/setup.js";
import { ChatController } from "./controller.js";

let shared: ChatController | undefined;
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
    shared = new ChatController({ backend: client, config: aiConfig() });
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
