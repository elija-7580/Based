// BSD-159 / ADR 0005: ein ChatEvent-Strom für jede Engine (API-Modelle, lokale Modelle, später CLIs auf dem Server,
// gespeicherte Transkripte). Vokabular wie Swift `ChatEvent` (BasedBrain/Agent/ChatStream.swift), ergänzt um
// Nutzer-Nachricht, Tool-Call-Start/-Delta, Usage und Freigabe-Anfrage, damit das Transkript vollständig ist (BSD-77).
// Objekte sind „loose“: unbekannte Felder neuerer Versionen bleiben beim Lesen und Zurückschreiben erhalten (ADR 0002).
import { z } from "zod";
import { jsonValue, type JSONValue } from "@based/core";

const ev = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.looseObject({ type: z.literal(type), ...shape });

export const chatEvent = z.union([
  /** Der Turn beginnt (Modell, ggf. Sitzung der Engine zum Fortsetzen). */
  ev("started", { model: z.string().optional(), sessionID: z.string().optional() }),
  /** Was der Nutzer geschrieben hat (steht im Transkript vor dem Turn). `at` = ms seit 1970. */
  ev("userMessage", { text: z.string(), at: z.number().optional() }),
  /** Teilstücke, während ein Block gestreamt wird. */
  ev("thinkingDelta", { text: z.string() }),
  ev("textDelta", { text: z.string() }),
  /** Fertiger Block (ersetzt den aus Deltas gebauten). */
  ev("thinking", { text: z.string() }),
  ev("text", { text: z.string() }),
  /** Ein Tool-Call beginnt zu streamen (Name bekannt, Eingabe noch nicht). */
  ev("toolStart", { id: z.string(), name: z.string() }),
  /** Teilstück der JSON-Eingabe eines Tool-Calls. */
  ev("toolInputDelta", { id: z.string(), json: z.string() }),
  /** Vollständiger Tool-Call. */
  ev("toolUse", { id: z.string(), name: z.string(), input: jsonValue }),
  /** Das Werkzeug wartet auf die Freigabe des Nutzers (Permission „Ask …“). */
  ev("permissionRequest", { id: z.string(), name: z.string() }),
  ev("toolResult", { id: z.string(), output: z.string(), isError: z.boolean() }),
  /** Verbrauch eines Modellaufrufs; `costUSD` ist geschätzt, wenn der Anbieter nichts meldet (`estimated`). */
  ev("usage", { inputTokens: z.number(), outputTokens: z.number(), costUSD: z.number().optional(), estimated: z.boolean().optional(), model: z.string().optional() }),
  /** Hinweis, der nicht Teil der Antwort ist („continuing a cut-off answer…“). */
  ev("notice", { text: z.string() }),
  /** Der Turn endete mit einem Fehler oder wurde gestoppt. */
  ev("failed", { message: z.string(), stopped: z.boolean().optional() }),
  /** Turn-Ende. */
  ev("result", { text: z.string(), sessionID: z.string().optional(), costUSD: z.number().optional(), isError: z.boolean() }),
]);

export type ChatEvent = z.infer<typeof chatEvent>;
export type ChatEventType = ChatEvent["type"];
export type ChatEventOf<T extends ChatEventType> = Extract<ChatEvent, { type: T }>;
export type { JSONValue };

/** Ein Ereignis einer neueren Version (unbekannter `type`): bleibt im Transkript, wird nicht gezeichnet. */
export const unknownChatEvent = z.looseObject({ type: z.string() });
export type StoredChatEvent = ChatEvent | z.infer<typeof unknownChatEvent>;

const KNOWN = new Set<string>(["started", "userMessage", "thinkingDelta", "textDelta", "thinking", "text", "toolStart", "toolInputDelta", "toolUse", "permissionRequest", "toolResult", "usage", "notice", "failed", "result"]);

/** Bekanntes Ereignis? (Unbekannte Typen neuerer Versionen überspringt der TurnBuilder.) */
export function isKnownChatEvent(e: StoredChatEvent): e is ChatEvent {
  return KNOWN.has(e.type);
}

/** Gespeicherte Ereignisliste lesen: bekannte streng, unbekannte Typen unverändert; kaputte Einträge fallen weg. */
export function parseChatEvents(value: unknown): StoredChatEvent[] {
  if (!Array.isArray(value)) return [];
  const out: StoredChatEvent[] = [];
  for (const raw of value) {
    const known = chatEvent.safeParse(raw);
    if (known.success) out.push(known.data);
    else {
      const u = unknownChatEvent.safeParse(raw);
      if (u.success && !KNOWN.has(u.data.type)) out.push(u.data);
    }
  }
  return out;
}

/** Turn-Ende? (`result` oder `failed`). */
export const isTerminal = (e: StoredChatEvent): boolean => e.type === "result" || e.type === "failed";

/**
 * Ereignisse fürs Speichern verdichten, ohne dass der TurnBuilder etwas anderes daraus faltet: benachbarte Deltas
 * werden eins; Deltas, deren fertiger Block folgt (`thinking`/`text`/`toolUse`), und beantwortete Freigabe-Anfragen
 * fallen weg. Bei einem abgebrochenen Turn bleiben die Deltas als einziger Beleg des Geschriebenen stehen.
 */
export function compactEvents(events: readonly StoredChatEvent[]): StoredChatEvent[] {
  const out: StoredChatEvent[] = [];
  // Index des offenen (noch nicht durch einen fertigen Block ersetzten) Deltas je Art im aktuellen Turn.
  let openThinking = -1, openText = -1;
  // Seit dem offenen Text kam ein Tool-Call: weiterer Text ist ein neuer Block (wie im TurnBuilder).
  let toolSinceText = false;
  const drop = (i: number) => {
    out.splice(i, 1);
    if (openThinking > i) openThinking -= 1;
    else if (openThinking === i) openThinking = -1;
    if (openText > i) openText -= 1;
    else if (openText === i) openText = -1;
  };
  for (const e of events) {
    if (!isKnownChatEvent(e)) { out.push(e); continue; }
    const last = out[out.length - 1];
    switch (e.type) {
      case "thinkingDelta":
        if (last?.type === "thinkingDelta" && openThinking === out.length - 1) (out[out.length - 1] as ChatEventOf<"thinkingDelta">) = { ...(last as ChatEventOf<"thinkingDelta">), text: (last as ChatEventOf<"thinkingDelta">).text + e.text };
        else { out.push({ ...e }); openThinking = out.length - 1; }
        break;
      case "textDelta":
        if (last?.type === "textDelta" && openText === out.length - 1) (out[out.length - 1] as ChatEventOf<"textDelta">) = { ...(last as ChatEventOf<"textDelta">), text: (last as ChatEventOf<"textDelta">).text + e.text };
        else if (openText >= 0 && !toolSinceText) {
          // Fortsetzung eines abgeschnittenen Texts: derselbe vorläufige Block wächst weiter.
          const cur = out[openText] as ChatEventOf<"textDelta">;
          out[openText] = { ...cur, text: cur.text + e.text };
        } else { out.push({ ...e }); openText = out.length - 1; toolSinceText = false; }
        break;
      case "thinking":
        if (openThinking >= 0) out[openThinking] = e;
        else out.push(e);
        openThinking = -1;
        break;
      case "text":
        if (openText >= 0) out[openText] = e;
        else out.push(e);
        openText = -1;
        toolSinceText = false;
        break;
      case "toolUse": {
        // Der fertige Call tritt an die Stelle seines `toolStart` (die Reihenfolge der Karten bleibt).
        let at = -1;
        for (let i = out.length - 1; i >= 0; i--) {
          const x = out[i]!;
          if ((x as { id?: string }).id !== e.id) continue;
          if (x.type === "toolInputDelta") drop(i);
          else if (x.type === "toolStart") { at = i; break; }
        }
        if (at >= 0) {
          // nach dem Entfernen der Deltas (alle hinter `at`) stimmt der Index noch
          out[at] = e;
        } else out.push(e);
        toolSinceText = true;
        break;
      }
      case "toolStart":
        out.push(e);
        toolSinceText = true;
        break;
      case "toolResult": {
        for (let i = out.length - 1; i >= 0; i--) {
          const x = out[i]!;
          if (x.type === "permissionRequest" && (x as { id?: string }).id === e.id) drop(i);
        }
        out.push(e);
        break;
      }
      case "userMessage": case "result": case "failed":
        out.push(e);
        openThinking = -1;
        openText = -1;
        toolSinceText = false;
        break;
      default:
        out.push(e);
    }
  }
  return out;
}
