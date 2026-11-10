// Das eine BrainChat-Objekt je ChatController (wird in chat/runtime.ts beim Anlegen des Controllers eingehängt) und
// der Haken für E2E (`globalThis.__basedBrain`).
import { ScriptedEngine, type ScriptStep } from "@based/brain";
import type { ChatController } from "../chat/controller.js";
import type { StoreClient } from "../worker/client.js";
import { BrainClient } from "./client.js";
import { BrainChat } from "./runtime.js";
import { brainSettings } from "./settings.js";

const byController = new WeakMap<ChatController, BrainChat>();

export function installBrain(client: StoreClient, controller: ChatController): BrainChat {
  let b = byController.get(controller);
  if (b) return b;
  b = new BrainChat(new BrainClient(client), controller);
  b.install();
  byController.set(controller, b);
  const brain = b;
  (globalThis as { __basedBrain?: unknown }).__basedBrain = {
    brain,
    settings: brainSettings(),
    /** Was die Engine zuletzt bekam (zeigt, dass nur Platzhalter rausgehen). */
    seen: [] as string[],
    /**
     * Antworten, die zeigen, was die Engine gesehen hat: Echo der Anfrage (Platzhalter) plus optional ein festes
     * Skript danach. Die Engine wird – wie ein externes Modell – vom Redact-Schritt eingehüllt.
     */
    useEcho(after: ScriptStep[] = []) {
      const seen = (globalThis as unknown as { __basedBrain: { seen: string[] } }).__basedBrain.seen;
      controller.setEngineFactory((ctx) => new ScriptedEngine({
        tools: ctx.tools, policy: ctx.policy,
        script: (req) => {
          seen.push(req.prompt);
          return [{ text: `Noted: ${req.prompt}` }, ...after];
        },
      }));
    },
    /** Memory-Vorschläge ohne Modell: feste Antwort des Extraktors. */
    useExtractor(answer: string) {
      brain.extractor = async () => answer;
    },
  };
  return b;
}

export const brainChatOf = (controller: ChatController): BrainChat | undefined => byController.get(controller);
