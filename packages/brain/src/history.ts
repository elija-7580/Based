// Aus dem gespeicherten Transkript (ChatEvents) den Verlauf für den nächsten Modellaufruf bauen: Nutzer-Nachrichten,
// Assistenten-Text, Tool-Calls und ihre Ergebnisse. Thinking wird nicht mitgeschickt (die API verlangt es nur
// innerhalb einer laufenden Tool-Schleife). Ein Tool-Call ohne Ergebnis (abgebrochen) bekommt eines, sonst lehnt
// der Anbieter den Verlauf ab.
import { compactEvents, isKnownChatEvent, type StoredChatEvent } from "./events.js";
import type { ChatMessage } from "./messages.js";
import { TOOL_OUTPUT_MODEL_LIMIT } from "./engine.js";

export function historyFromEvents(events: readonly StoredChatEvent[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  let pending: ChatMessage | undefined;
  /** Calls des zuletzt geschriebenen Assistenten-Schritts, die noch kein Ergebnis haben. */
  let open: string[] = [];
  const closeOpen = () => {
    for (const id of open) out.push({ role: "tool", content: "(interrupted – no result)", toolCallID: id });
    open = [];
  };
  const flush = () => {
    if (!pending) return;
    if (pending.content !== "" || (pending.toolCalls?.length ?? 0) > 0) {
      out.push(pending);
      open = (pending.toolCalls ?? []).map((c) => c.id);
    }
    pending = undefined;
  };
  const addText = (t: string) => {
    if (t === "") return;
    if (pending && (pending.toolCalls?.length ?? 0) > 0) flush();
    if (!pending) {
      closeOpen();
      pending = { role: "assistant", content: t };
    } else pending.content = pending.content ? pending.content + "\n\n" + t : t;
  };
  for (const e of compactEvents(events)) {
    if (!isKnownChatEvent(e)) continue;
    switch (e.type) {
      case "userMessage":
        flush();
        closeOpen();
        out.push({ role: "user", content: e.text });
        break;
      case "text": case "textDelta":
        addText(e.text);
        break;
      case "toolUse":
        if (!pending) {
          closeOpen();
          pending = { role: "assistant", content: "" };
        }
        pending.toolCalls = [...(pending.toolCalls ?? []), { id: e.id, name: e.name, arguments: e.input }];
        break;
      case "toolResult":
        flush();
        if (open.includes(e.id)) {
          open = open.filter((x) => x !== e.id);
          out.push({ role: "tool", content: e.output.slice(0, TOOL_OUTPUT_MODEL_LIMIT), toolCallID: e.id });
        }
        break;
      case "result": case "failed":
        flush();
        closeOpen();
        break;
      default:
        break;
    }
  }
  flush();
  closeOpen();
  return out;
}
