// Kontext-Kompaktierung (Swift `ContextBudgetTests`), Warteschlange (Swift `PromptQueueTests`), Verlauf aus Events, Kosten.
import { describe, expect, it } from "vitest";
import { AIError, compactionNotice, ContextBudget, estimateCost, formatCost, formatTokens, historyFromEvents, priceFor, PromptQueue, type ChatMessage, type RunningTurn } from "../src/index.js";

const u = (content: string): ChatMessage => ({ role: "user", content });
const a = (content: string): ChatMessage => ({ role: "assistant", content });

describe("ContextBudget", () => {
  it("unter der Schwelle bleibt alles", async () => {
    const m = [{ role: "system" as const, content: "s" }, u("hi"), a("hello")];
    const { messages, report } = await new ContextBudget(10_000).fit(m);
    expect(messages).toEqual(m);
    expect(compactionNotice(report)).toBeUndefined();
  });

  it("1. kürzt alte Tool-Ergebnisse, die letzten vier des aktuellen Turns bleiben", async () => {
    const tool = (i: number): ChatMessage => ({ role: "tool", content: `r${i} ` + "x".repeat(3000), toolCallID: "c" + i });
    const m: ChatMessage[] = [u("old"), tool(0), a("ok"), u("now"), ...[1, 2, 3, 4, 5, 6].map(tool)];
    const { messages, report } = await new ContextBudget(6000).fit(m);
    expect(report.shortenedToolResults).toBe(3);
    expect(messages.map((x) => x.content.length > 1100)).toEqual([false, false, false, false, false, false, true, true, true, true]);
    expect(messages[1]!.content.endsWith("[… shortened to fit the context window]")).toBe(true);
    expect(compactionNotice(report)).toBe("Long tool results and messages were shortened to fit the context window.");
    expect(m[1]!.content.length, "die Eingabe bleibt unverändert").toBe(3003);
  });

  it("2. ältere Turns werden zusammengefasst (letzte 6 bleiben); ohne Zusammenfasser weggelassen", async () => {
    const m: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 10; i++) m.push(u(`q${i} ` + "y".repeat(700)), a(`a${i}`));
    const seen: string[] = [];
    const b = new ContextBudget(2500);
    const { messages, report } = await b.fit(m, async (t) => { seen.push(t); return "They talked about q0–q3."; });
    expect(report.summarizedMessages).toBe(8);
    expect(messages[0]!.content).toBe("sys\n\n# Earlier in this conversation (summary)\nThey talked about q0–q3.");
    expect(messages.filter((x) => x.role === "user").map((x) => x.content.slice(0, 2))).toEqual(["q4", "q5", "q6", "q7", "q8", "q9"]);
    expect(seen[0]!.startsWith("user: q0 ")).toBe(true);
    expect(compactionNotice(report)).toBe("Older messages were summarized to fit the context window.");
    const dropped = await b.fit(m, async () => { throw new Error("offline"); });
    expect(dropped.report.droppedMessages).toBe(8);
    expect(dropped.messages[0]!.content).toContain("(8 older messages were left out to fit the context window.)");
    const noSystem = await b.fit(m.slice(1));
    expect(noSystem.messages[0]).toMatchObject({ role: "system" });
  });

  it("3. riesige Nachrichten werden in der Mitte gekürzt, nie die neueste Nutzer-Nachricht", async () => {
    const m: ChatMessage[] = [u("A".repeat(20_000) + "END"), a("ok"), u("B".repeat(9000))];
    const { messages, report } = await new ContextBudget(4000).fit(m);
    expect(report.shortenedMessages).toBe(1);
    expect(messages[0]!.content).toContain("[… shortened to fit the context window …]");
    expect(messages[0]!.content.endsWith("END")).toBe(true);
    expect(messages[2]!.content).toHaveLength(9000);
  });

  it("Fenstergrößen, Überlauf-Erkennung, Zusammenfassungs-Modell", () => {
    expect(ContextBudget.windowFor("anthropic/claude-sonnet-5-5")).toBe(200_000);
    expect(ContextBudget.windowFor("gpt-4.1-mini")).toBe(1_000_000);
    expect(ContextBudget.windowFor("llama3.1")).toBe(32_000);
    expect(ContextBudget.isContextOverflow(AIError.http(400, '{"error":{"code":"context_length_exceeded"}}'))).toBe(true);
    expect(ContextBudget.isContextOverflow(AIError.http(400, "bad json"))).toBe(false);
    expect(ContextBudget.isContextOverflow(AIError.http(500, "prompt is too long"))).toBe(false);
    expect(ContextBudget.summaryModel(["claude-opus-x", "claude-haiku-x"], "claude-opus-x")).toBe("claude-haiku-x");
    expect(ContextBudget.summaryModel(["big"], "big")).toBe("big");
    expect(ContextBudget.tokensOfText("1234567")).toBe(2);
  });
});

describe("PromptQueue", () => {
  function setup() {
    const started: string[] = [];
    const finish: (() => void)[] = [];
    const cancelled: string[] = [];
    const q = new PromptQueue<string>((p): RunningTurn | undefined => {
      if (p === "") return undefined;
      started.push(p);
      let done!: () => void;
      const promise = new Promise<void>((r) => { done = r; });
      finish.push(done);
      return { done: promise, cancel: () => { cancelled.push(p); done(); } };
    });
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    return { q, started, finish, cancelled, tick };
  }

  it("sendet sofort, wenn frei; sonst der Reihe nach, erst wenn der vorige Turn ganz fertig ist", async () => {
    const { q, started, finish, tick } = setup();
    expect(q.submit("a", "a")).toBeUndefined();
    const b = q.submit("b", "b"), c = q.submit("c", "c");
    expect(b && c).toBeTruthy();
    expect(started).toEqual(["a"]);
    expect(q.waiting.map((x) => x.text)).toEqual(["b", "c"]);
    finish[0]!();
    await tick();
    expect(started).toEqual(["a", "b"]);
    finish[1]!();
    await tick();
    finish[2]!();
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    expect(q.isBusy).toBe(false);
  });

  it("zurücknehmen, „Send now“ (zieht vor und stoppt), Stop lässt Wartende folgen", async () => {
    const { q, started, cancelled, tick } = setup();
    q.submit("a", "a");
    const b = q.submit("b", "b")!, c = q.submit("c", "c")!;
    q.remove(b);
    expect(q.waiting.map((x) => x.text)).toEqual(["c"]);
    const d = q.submit("d", "d")!;
    q.sendNow(d);
    expect(cancelled).toEqual(["a"]);
    await tick();
    expect(started).toEqual(["a", "d"]);
    q.stopCurrent();
    await tick();
    expect(started).toEqual(["a", "d", "c"]);
    expect(c).toBeTruthy();
  });

  it("nichts zu senden: die Schlange geht weiter; detach lässt den laufenden Turn nicht mehr blockieren", async () => {
    const { q, started, finish, tick } = setup();
    q.submit("a", "a");
    q.submit("empty", "");
    q.submit("b", "b");
    finish[0]!();
    await tick();
    expect(started).toEqual(["a", "b"]);
    let changes = 0;
    q.onChange = () => { changes += 1; };
    q.submit("c", "c");
    q.detach();
    expect(q.isBusy).toBe(false);
    expect(q.waiting).toEqual([]);
    q.submit("x", "x");
    expect(started).toEqual(["a", "b", "x"]);
    finish[1]!();
    await tick();
    expect(q.isBusy, "der alte Turn beendet nicht den neuen").toBe(true);
    expect(changes).toBeGreaterThan(1);
  });
});

describe("historyFromEvents", () => {
  it("Text, Tool-Calls und Ergebnisse werden Nachrichten; Thinking und Hinweise nicht", () => {
    const h = historyFromEvents([
      { type: "userMessage", text: "find trip" }, { type: "started", model: "m" }, { type: "thinking", text: "hm" }, { type: "text", text: "Searching." },
      { type: "toolUse", id: "c1", name: "search", input: { query: "trip" } }, { type: "toolResult", id: "c1", output: "- Trip", isError: false },
      { type: "notice", text: "n" }, { type: "text", text: "Found it." }, { type: "result", text: "Found it.", isError: false },
      { type: "userMessage", text: "thanks" },
    ]);
    expect(h).toEqual([
      { role: "user", content: "find trip" },
      { role: "assistant", content: "Searching.", toolCalls: [{ id: "c1", name: "search", arguments: { query: "trip" } }] },
      { role: "tool", content: "- Trip", toolCallID: "c1" },
      { role: "assistant", content: "Found it." },
      { role: "user", content: "thanks" },
    ]);
  });

  it("abgebrochener Turn: Teiltext bleibt, ein Call ohne Ergebnis bekommt eines", () => {
    const h = historyFromEvents([
      { type: "userMessage", text: "go" }, { type: "textDelta", text: "Half " }, { type: "textDelta", text: "answer" },
      { type: "toolUse", id: "c1", name: "create_page", input: {} }, { type: "failed", message: "Stopped.", stopped: true },
      { type: "userMessage", text: "again" }, { type: "failed", message: "HTTP 500" },
    ]);
    expect(h).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "Half answer", toolCalls: [{ id: "c1", name: "create_page", arguments: {} }] },
      { role: "tool", content: "(interrupted – no result)", toolCallID: "c1" },
      { role: "user", content: "again" },
    ]);
  });
});

describe("Kosten", () => {
  it("Preisklassen wie in Swift ModelPricing; lokale Modelle kosten nichts", () => {
    expect(priceFor("ollama/llama3.1")).toEqual({ input: 0, output: 0 });
    expect(priceFor("anthropic/claude-haiku-x")).toEqual({ input: 1, output: 5 });
    expect(priceFor("anthropic/claude-opus-x")).toEqual({ input: 5, output: 25 });
    expect(priceFor("openai/gpt-4.1")).toEqual({ input: 3, output: 15 });
    expect(estimateCost("openai/gpt-4.1", { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(4.5);
    expect([formatTokens(950), formatTokens(1200), formatTokens(34_400), formatTokens(1_100_000)]).toEqual(["950", "1.2k", "34k", "1.1M"]);
    expect([formatCost(0), formatCost(0.0042), formatCost(0.129), formatCost(2.4)]).toEqual(["$0", "$0.0042", "$0.13", "$2.40"]);
  });
});
