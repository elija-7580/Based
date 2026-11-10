// Hält ein Gespräch im Kontextfenster des Modells (Swift `ContextBudget`, BSD-47): lange Chats werden verdichtet,
// statt mit „prompt too long“ zu scheitern.
//
// Schätzung: Zeichen / 3,5 je Nachricht (+ Tool-Argumente, + Pauschale je Bild). Ab 75 % des Fensters, in dieser
// Reihenfolge, bis es passt:
// 1. Tool-Ergebnisse außerhalb des neuesten Turns – und alle bis auf die letzten 4 darin – auf 1 kB kürzen;
// 2. Turns älter als die letzten 6 zu einer „So far“-Zusammenfassung verdichten (ans System-Prompt angehängt);
//    ohne Zusammenfasser (oder wenn er scheitert) mit einem Hinweis weglassen;
// 3. immer noch zu groß: die längsten älteren Nachrichten in der Mitte kürzen.
// System-Nachricht und neueste Nutzer-Nachricht werden nie gekürzt.
import { AIError, type ChatMessage } from "./messages.js";

export interface CompactionReport {
  before: number;
  after: number;
  shortenedToolResults: number;
  summarizedMessages: number;
  droppedMessages: number;
  shortenedMessages: number;
  summary?: string;
}

export const compactionChanged = (r: CompactionReport) => r.shortenedToolResults + r.summarizedMessages + r.droppedMessages + r.shortenedMessages > 0;

export function compactionNotice(r: CompactionReport): string | undefined {
  if (r.summarizedMessages > 0) return "Older messages were summarized to fit the context window.";
  if (r.droppedMessages > 0) return "Older messages were left out to fit the context window.";
  if (compactionChanged(r)) return "Long tool results and messages were shortened to fit the context window.";
  return undefined;
}

export type Summarizer = (text: string) => Promise<string>;

export class ContextBudget {
  /** Verdichten beginnt über diesem Anteil des Fensters. */
  threshold = 0.75;
  /** Turns (Nutzer-Nachricht und alles danach), die wörtlich bleiben. */
  keepTurns = 6;
  /** Tool-Ergebnisse, die im aktuellen Turn vollständig bleiben. */
  keepToolResults = 4;
  /** Ältere Tool-Ergebnisse werden auf so viele Zeichen gekürzt. */
  toolResultLimit = 1000;
  static readonly imageTokens = 1600;

  /** `window`: Kontextfenster in Tokens. */
  constructor(public window: number) {}

  /** Bekannte Modellfamilien, sonst vorsichtige 32k (Swift `window(for:)`). */
  static windowFor(model: string): number {
    const m = model.toLowerCase();
    const name = m.split("/").pop() ?? m;
    if (name.includes("on-device") || m.startsWith("apple/")) return 4096;
    if (name.startsWith("claude")) return 200_000;
    if (name.startsWith("gpt-4.1")) return 1_000_000;
    if (name.startsWith("gpt-5")) return 400_000;
    if (name.startsWith("o1") || name.startsWith("o3") || name.startsWith("o4")) return 200_000;
    if (name.startsWith("gpt-4o") || name.startsWith("gpt-4-turbo")) return 128_000;
    if (name.startsWith("gemini")) return 1_000_000;
    return 32_000;
  }

  get limit(): number {
    return Math.floor(this.window * this.threshold);
  }

  static tokensOfText(text: string): number {
    return Math.ceil(text.length / 3.5);
  }

  static tokensOf(m: ChatMessage): number {
    let n = 4 + ContextBudget.tokensOfText(m.content);
    for (const c of m.toolCalls ?? []) n += ContextBudget.tokensOfText(c.name) + ContextBudget.tokensOfText(JSON.stringify(c.arguments));
    if (Array.isArray(m.rawContent)) {
      // Thinking-Blöcke werden in einer Tool-Schleife mitgeschickt; Bilder zählen pauschal.
      for (const b of m.rawContent) {
        if (b === null || typeof b !== "object" || Array.isArray(b)) continue;
        if (b.type === "thinking" && typeof b.thinking === "string") n += ContextBudget.tokensOfText(b.thinking);
        else if (b.type === "image") n += ContextBudget.imageTokens;
      }
    }
    return n;
  }

  static tokens(messages: readonly ChatMessage[]): number {
    return messages.reduce((n, m) => n + ContextBudget.tokensOf(m), 0);
  }

  /** Die Nachrichten, die geschickt werden. `force` verdichtet auch unter der Schwelle (nach einem „too long“-Fehler). */
  async fit(input: readonly ChatMessage[], summarizer?: Summarizer, force = false): Promise<{ messages: ChatMessage[]; report: CompactionReport }> {
    const m = input.map((x) => ({ ...x }));
    const r: CompactionReport = { before: ContextBudget.tokens(m), after: 0, shortenedToolResults: 0, summarizedMessages: 0, droppedMessages: 0, shortenedMessages: 0 };
    r.after = r.before;
    const target = force ? Math.floor(this.limit / 2) : this.limit;
    if (r.before <= target) return { messages: m, report: r };

    // Turn-Anfänge: Nutzer-Nachrichten (Tool-Ergebnisse haben role tool, ein Turn enthält also seine ganze Schleife).
    const starts = m.flatMap((x, i) => (x.role === "user" ? [i] : []));
    const lastStart = starts[starts.length - 1] ?? m.length;
    const keepFrom = starts.length > this.keepTurns ? starts[starts.length - this.keepTurns]! : starts[0] ?? m.length;

    // 1. Tool-Ergebnisse.
    const currentTools = m.flatMap((x, i) => (i >= lastStart && x.role === "tool" ? [i] : []));
    const protectedTools = new Set(currentTools.slice(-this.keepToolResults));
    m.forEach((x, i) => {
      if (x.role === "tool" && !protectedTools.has(i) && x.content.length > this.toolResultLimit) {
        x.content = x.content.slice(0, this.toolResultLimit) + "\n[… shortened to fit the context window]";
        r.shortenedToolResults += 1;
      }
    });
    r.after = ContextBudget.tokens(m);
    if (r.after <= target) return { messages: m, report: r };

    // 2. Ältere Turns → Zusammenfassung im System-Prompt.
    const hasSystem = m[0]?.role === "system";
    const olderStart = hasSystem ? 1 : 0;
    if (keepFrom > olderStart) {
      const older = m.slice(olderStart, keepFrom);
      let summary: string | undefined;
      if (summarizer) {
        const text = older.map((x) => `${x.role}: ${x.content}`).join("\n\n");
        // Der Zusammenfasser bekommt selbst höchstens das halbe Fenster.
        const cap = Math.floor((this.window / 2) * 3.5);
        const half = Math.floor(cap / 2);
        const clipped = text.length > cap ? text.slice(0, half) + "\n[…]\n" + text.slice(-half) : text;
        try {
          summary = await summarizer(clipped);
        } catch {
          summary = undefined;
        }
        if (summary !== undefined && summary.trim() === "") summary = undefined;
      }
      m.splice(olderStart, keepFrom - olderStart);
      const note = summary !== undefined
        ? "# Earlier in this conversation (summary)\n" + summary
        : `# Earlier in this conversation\n(${older.length} older messages were left out to fit the context window.)`;
      if (hasSystem) m[0]!.content += "\n\n" + note;
      else m.unshift({ role: "system", content: note });
      if (summary !== undefined) {
        r.summarizedMessages = older.length;
        r.summary = summary;
      } else r.droppedMessages = older.length;
      r.after = ContextBudget.tokens(m);
      if (r.after <= target) return { messages: m, report: r };
    }

    // 3. Die längsten Nachrichten kürzen (nicht das System-Prompt, nicht die neueste Nutzer-Nachricht, keine
    //    Assistenten-Nachrichten mit mitgeschickten Blöcken), bis auf je 2000 Zeichen, längste zuerst.
    const newestUser = m.findLastIndex((x) => x.role === "user");
    const candidates = m.flatMap((x, i) => (x.role !== "system" && i !== newestUser && x.rawContent === undefined && x.content.length > 2000 ? [i] : []));
    candidates.sort((a, b) => m[b]!.content.length - m[a]!.content.length);
    for (const i of candidates) {
      const total = ContextBudget.tokens(m);
      if (total <= target) break;
      const c = m[i]!.content;
      const keep = Math.max(2000, c.length - (total - target) * 4);
      if (keep >= c.length) continue;
      const half = Math.floor(keep / 2);
      m[i]!.content = c.slice(0, half) + "\n[… shortened to fit the context window …]\n" + c.slice(-half);
      r.shortenedMessages += 1;
    }
    r.after = ContextBudget.tokens(m);
    return { messages: m, report: r };
  }

  /** Der Anbieter sagt, das Prompt sei zu lang (HTTP 400/413 mit einer Kontextlängen-Meldung). */
  static isContextOverflow(error: unknown): boolean {
    if (!(error instanceof AIError) || error.kind !== "http" || (error.status !== 400 && error.status !== 413)) return false;
    const b = (error.body ?? "").toLowerCase();
    return ["prompt is too long", "context_length_exceeded", "maximum context length", "context window", "too many tokens", "input is too long"].some((s) => b.includes(s));
  }

  /** Ein günstigeres Modell desselben Anbieters für Zusammenfassungen (Haiku, mini), sonst das Modell selbst. */
  static summaryModel(models: readonly string[], fallback: string): string {
    return models.find((m) => m.includes("haiku")) ?? models.find((m) => m.includes("mini")) ?? fallback;
  }
}
