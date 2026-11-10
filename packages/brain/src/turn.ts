// BSD-159: faltet ChatEvents deterministisch zu den Teilen eines Assistenten-Turns (Thinking, Text, Tool-Karten) –
// portiert aus Swift `ChatTurnBuilder` (BasedBrain/Agent/ChatStream.swift). Ohne Uhr und ohne Zufall: dieselbe
// Ereignisfolge ergibt immer dieselben Teile (IDs zählen hoch), live wie beim Wiederöffnen eines Transkripts.
// Nicht portiert: To-do-Listen (TodoWrite) und Datei-Diffs der Coding-CLIs – die Engines dafür laufen auf dem Server.
import { isKnownChatEvent, type ChatEvent, type JSONValue, type StoredChatEvent } from "./events.js";

export type ChatPartKind = "thinking" | "text" | "tool";
/** `waiting`: das Werkzeug wartet auf die Freigabe des Nutzers. */
export type ChatPartStatus = "running" | "waiting" | "done" | "failed";

export interface ChatPart {
  id: string;
  kind: ChatPartKind;
  text: string;
  /** Werkzeuge: roher Name („create_page“) und kurzes Argument („Trip plan“). */
  toolName: string;
  detail: string;
  /** Vollständige Eingabe des Werkzeugs (sobald `toolUse` da ist). */
  input?: JSONValue;
  /** Gestreamte Eingabe, solange der Call noch nicht vollständig ist. */
  inputJSON?: string;
  output?: string;
  status: ChatPartStatus;
  /** Aus Deltas gebaut; wird ersetzt, wenn der fertige Block kommt. */
  provisional: boolean;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  /** Mindestens ein Kostenwert war geschätzt. */
  estimated: boolean;
}

export const ZERO_USAGE: TurnUsage = { inputTokens: 0, outputTokens: 0, costUSD: 0, estimated: false };

export function addUsage(a: TurnUsage, e: { inputTokens: number; outputTokens: number; costUSD?: number | undefined; estimated?: boolean | undefined }): TurnUsage {
  return {
    inputTokens: a.inputTokens + e.inputTokens,
    outputTokens: a.outputTokens + e.outputTokens,
    costUSD: a.costUSD + (e.costUSD ?? 0),
    estimated: a.estimated || e.estimated === true,
  };
}

const part = (id: string, kind: ChatPartKind, text = "", status: ChatPartStatus = "done"): ChatPart => ({ id, kind, text, toolName: "", detail: "", status, provisional: false });

/** Kurzes Argument für eine Tool-Karte: Datei, Befehl, Muster, URL, Suchbegriff, Titel … (Swift `summary`). */
export function toolSummary(input: JSONValue): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return "";
  const str = (v: JSONValue | undefined): string | undefined => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);
  for (const key of ["file_path", "path", "notebook_path", "command", "pattern", "url", "query", "description", "prompt", "title", "id", "page_id"]) {
    const v = str(input[key]);
    if (v) return v.replace(/\n/g, " ").slice(0, 160);
  }
  const first = Object.keys(input).sort().map((k) => str(input[k])).find((v) => v !== undefined);
  return first ? first.slice(0, 160) : "";
}

export class ChatTurnBuilder {
  parts: ChatPart[] = [];
  sessionID: string | undefined;
  model: string | undefined;
  /** Kosten, die die Engine für den ganzen Turn gemeldet hat (`result.costUSD`). */
  costUSD: number | undefined;
  finalText: string | undefined;
  isError = false;
  /** Fehlermeldung (`failed`); `stopped`, wenn der Nutzer abgebrochen hat. */
  error: string | undefined;
  stopped = false;
  /** Der Turn ist zu Ende (`result` oder `failed`). */
  done = false;
  notices: string[] = [];
  usage: TurnUsage = { ...ZERO_USAGE };
  private counter = 0;

  private nextID(prefix: string): string {
    this.counter += 1;
    return prefix + this.counter;
  }

  /** Der Antworttext (alle Textteile), für Kurzfassung, Kopieren und den Verlauf des nächsten Turns. */
  get text(): string {
    const texts = this.parts.filter((p) => p.kind === "text" && p.text !== "");
    if (texts.length === 0 && this.finalText) return this.finalText;
    return texts.map((p) => p.text).join("\n\n");
  }

  get isThinking(): boolean {
    const last = this.parts[this.parts.length - 1];
    return last?.kind === "thinking" && last.status === "running";
  }

  apply(e: StoredChatEvent): void {
    if (!isKnownChatEvent(e)) return;
    this.applyKnown(e);
  }

  private applyKnown(e: ChatEvent): void {
    const last = this.parts[this.parts.length - 1];
    switch (e.type) {
      case "started":
        this.model = e.model ?? this.model;
        this.sessionID = e.sessionID ?? this.sessionID;
        break;
      case "userMessage":
        break;
      case "thinkingDelta":
        if (last?.kind === "thinking" && last.provisional) last.text += e.text;
        else this.parts.push({ ...part(this.nextID("th"), "thinking", e.text, "running"), provisional: true });
        break;
      case "textDelta": {
        this.closeThinking();
        const cur = this.parts[this.parts.length - 1];
        if (cur?.kind === "text" && cur.provisional) cur.text += e.text;
        else this.parts.push({ ...part(this.nextID("tx"), "text", e.text, "running"), provisional: true });
        break;
      }
      case "thinking": {
        const p = this.lastProvisional("thinking");
        if (p) { p.text = e.text; p.provisional = false; p.status = "done"; }
        else this.parts.push(part(this.nextID("th"), "thinking", e.text));
        break;
      }
      case "text": {
        this.closeThinking();
        const p = this.lastProvisional("text");
        if (p) { p.text = e.text; p.provisional = false; p.status = "done"; }
        else if (e.text !== "") this.parts.push(part(this.nextID("tx"), "text", e.text));
        break;
      }
      case "toolStart": {
        this.closeThinking();
        this.closeProvisionalText();
        if (this.tool(e.id)) break;
        this.parts.push({ ...part(e.id || this.nextID("tl"), "tool", "", "running"), toolName: e.name, inputJSON: "" });
        break;
      }
      case "toolInputDelta": {
        const p = this.tool(e.id);
        if (p) p.inputJSON = (p.inputJSON ?? "") + e.json;
        break;
      }
      case "toolUse": {
        this.closeThinking();
        this.closeProvisionalText();
        const existing = e.id ? this.tool(e.id) : undefined;
        const p = existing ?? { ...part(e.id || this.nextID("tl"), "tool", "", "running") };
        p.toolName = e.name;
        p.detail = toolSummary(e.input);
        p.input = e.input;
        delete p.inputJSON;
        if (!existing) this.parts.push(p);
        break;
      }
      case "permissionRequest": {
        const p = this.tool(e.id);
        if (p && p.status === "running") p.status = "waiting";
        break;
      }
      case "toolResult": {
        const p = this.tool(e.id);
        if (!p) break;
        p.output = e.output;
        p.status = e.isError ? "failed" : "done";
        break;
      }
      case "usage":
        this.usage = addUsage(this.usage, e);
        this.model = e.model ?? this.model;
        break;
      case "notice":
        this.notices.push(e.text);
        break;
      case "result":
        this.finalText = e.text;
        this.sessionID = e.sessionID ?? this.sessionID;
        this.costUSD = e.costUSD ?? this.costUSD;
        this.isError = e.isError;
        this.done = true;
        for (const p of this.parts) {
          if (p.status === "running" || p.status === "waiting") p.status = "done";
          p.provisional = false;
        }
        if (!this.parts.some((p) => p.kind === "text" && p.text !== "") && e.text !== "" && !e.isError) this.parts.push(part(this.nextID("tx"), "text", e.text));
        break;
      case "failed":
        this.isError = true;
        this.error = e.message;
        this.stopped = e.stopped === true;
        this.done = true;
        for (const p of this.parts) {
          if (p.status === "running" || p.status === "waiting") p.status = p.kind === "tool" ? "failed" : "done";
          p.provisional = false;
        }
        break;
    }
  }

  private tool(id: string): ChatPart | undefined {
    return this.parts.find((p) => p.kind === "tool" && p.id === id);
  }

  private lastProvisional(kind: ChatPartKind): ChatPart | undefined {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i]!;
      if (p.kind === kind && p.provisional) return p;
    }
    return undefined;
  }

  private closeThinking() {
    const last = this.parts[this.parts.length - 1];
    if (last?.kind === "thinking" && last.status === "running") last.status = "done";
  }

  private closeProvisionalText() {
    const last = this.parts[this.parts.length - 1];
    if (last?.kind === "text" && last.status === "running") last.status = "done";
  }
}

// MARK: Transkript → Turns

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; at?: number }
  | { kind: "assistant"; id: string; turn: ChatTurnBuilder };

/**
 * Faltet ein ganzes Transkript (Ereignisse mehrerer Turns) zu Einträgen: Nutzer-Nachrichten und Assistenten-Turns.
 * Ein Turn beginnt mit dem ersten Ereignis nach einer Nutzer-Nachricht bzw. nach einem Turn-Ende.
 */
export class TranscriptBuilder {
  items: TranscriptItem[] = [];
  /** Verbrauch über alle Turns des Chats (BSD-74). */
  usage: TurnUsage = { ...ZERO_USAGE };
  private current: ChatTurnBuilder | undefined;
  private n = 0;

  /** Der laufende (noch nicht beendete) Turn. */
  get openTurn(): ChatTurnBuilder | undefined {
    return this.current;
  }

  apply(e: StoredChatEvent): void {
    if (!isKnownChatEvent(e)) return;
    if (e.type === "userMessage") {
      this.current = undefined;
      this.n += 1;
      this.items.push(e.at === undefined ? { kind: "user", id: "u" + this.n, text: e.text } : { kind: "user", id: "u" + this.n, text: e.text, at: e.at });
      return;
    }
    if (!this.current) {
      this.current = new ChatTurnBuilder();
      this.n += 1;
      this.items.push({ kind: "assistant", id: "a" + this.n, turn: this.current });
    }
    this.current.apply(e);
    if (e.type === "usage") this.usage = addUsage(this.usage, e);
    if (e.type === "result" && e.costUSD !== undefined && this.current.usage.costUSD === 0) this.usage = { ...this.usage, costUSD: this.usage.costUSD + e.costUSD };
    if (this.current.done) this.current = undefined;
  }

  applyAll(events: readonly StoredChatEvent[]): this {
    for (const e of events) this.apply(e);
    return this;
  }
}

export function foldTranscript(events: readonly StoredChatEvent[]): TranscriptBuilder {
  return new TranscriptBuilder().applyAll(events);
}
