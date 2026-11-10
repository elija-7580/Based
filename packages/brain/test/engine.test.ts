// Swift `ContinuationTests`, `ChatEngineTests` (Tool-Schleife, Fortsetzen, Abbruch) mit Fake-Anbieter.
import { describe, expect, it } from "vitest";
import { AIError, ChatTurnBuilder, CONTINUE_PROMPT, executeTool, ModelEngine, runTurn, ScriptedEngine, type ChatEvent, type ToolHost, type ToolResult } from "../src/index.js";
import { collect, ScriptedProvider } from "./helpers.js";

const fold = (events: ChatEvent[]) => {
  const b = new ChatTurnBuilder();
  for (const e of events) b.apply(e);
  return b;
};

function host(calls: string[] = [], result: (name: string) => ToolResult | Promise<ToolResult> = (n) => ({ text: n + " ok", isError: false })): ToolHost {
  return {
    specs: [{ name: "search", description: "s", inputSchema: {} }, { name: "create_page", description: "c", inputSchema: {} }],
    isWrite: (n) => n === "create_page",
    call: async (name, input) => {
      calls.push(name + JSON.stringify(input));
      return result(name);
    },
  };
}

const never = new AbortController().signal;

describe("ModelEngine", () => {
  it("Tool-Schleife: Deltas, Usage, Tool-Call, Ergebnis, Schlussantwort", async () => {
    const p = new ScriptedProvider([
      { thinking: "plan", text: "Let me search.", calls: [{ id: "c1", name: "search", arguments: { query: "trip" } }], stop: "tool_use", usage: { inputTokens: 100, outputTokens: 20 } },
      { text: "Done.", stop: "end_turn", usage: { inputTokens: 150, outputTokens: 5 } },
    ]);
    const calls: string[] = [];
    const engine = new ModelEngine({ provider: p, model: "m", tools: host(calls), policy: { mode: "free" }, today: () => "2026-11-10" });
    const events = await collect(runTurn(engine, { prompt: "find my trip", history: [{ role: "user", content: "earlier" }, { role: "assistant", content: "sure" }], system: "Be brief." }, never));
    expect(events.map((e) => e.type)).toEqual([
      "started", "thinkingDelta", "textDelta", "textDelta", "textDelta", "toolStart", "toolInputDelta", "usage", "thinking", "text", "toolUse", "toolResult",
      "textDelta", "usage", "text", "result",
    ]);
    expect(calls).toEqual(['search{"query":"trip"}']);
    const b = fold(events);
    expect(b.parts.map((x) => x.kind)).toEqual(["thinking", "text", "tool", "text"]);
    expect(b.usage).toMatchObject({ inputTokens: 250, outputTokens: 25, estimated: true });
    expect(events[events.length - 1]).toEqual({ type: "result", text: "Let me search.\n\nDone.", isError: false });
    // erster Aufruf: System (+ Datum, Agent-Anweisungen), Verlauf, Frage; zweiter: dazu Antwort und Tool-Ergebnis
    expect(p.seen[0]!.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(p.seen[0]![0]!.content).toContain("Today is 2026-11-10.");
    expect(p.seen[0]![0]!.content).toContain("# Agent instructions\nBe brief.");
    expect(p.seen[1]!.slice(-2)).toEqual([
      { role: "assistant", content: "Let me search.", toolCalls: [{ id: "c1", name: "search", arguments: { query: "trip" } }] },
      { role: "tool", content: "search ok", toolCallID: "c1" },
    ]);
    expect(p.seenOptions[0]!.tools.map((t) => t.name)).toEqual(["search", "create_page"]);
  });

  it("abgeschnittene Antwort wird einmal in denselben Text fortgesetzt", async () => {
    const p = new ScriptedProvider([{ thinking: "hmm", text: "Part one,", stop: "max_tokens" }, { thinking: "hmm", text: " part two.", stop: "end_turn" }]);
    const events = await collect(runTurn(new ModelEngine({ provider: p, model: "m" }), { prompt: "write" }, never));
    const second = p.seen[1]!;
    expect(second.slice(-2).map((m) => m.role)).toEqual(["assistant", "user"]);
    expect(second[second.length - 1]!.content).toBe(CONTINUE_PROMPT);
    const b = fold(events);
    expect(b.parts.filter((x) => x.kind === "text").map((x) => x.text), "ein Textteil, nicht zwei").toEqual(["Part one, part two."]);
    expect(b.parts.filter((x) => x.kind === "thinking"), "das Thinking der Fortsetzung erscheint nicht noch einmal").toHaveLength(1);
    expect(b.notices).toEqual(["The answer hit the length limit and was continued."]);
    expect(b.text).toBe("Part one, part two.");
    expect(b.usage).toMatchObject({ inputTokens: 2, outputTokens: 2 });
  });

  it("nach einer Fortsetzung immer noch abgeschnitten: markiert, kein dritter Aufruf", async () => {
    const p = new ScriptedProvider([{ text: "A", stop: "max_tokens" }, { text: "B", stop: "length" }]);
    const b = fold(await collect(runTurn(new ModelEngine({ provider: p, model: "m" }), { prompt: "write" }, never)));
    expect(b.text).toBe("AB");
    expect(p.seen).toHaveLength(2);
    expect(b.notices).toEqual(["The answer hit the length limit and was continued.", "The answer was cut off at the length limit."]);
  });

  it("Kontext-Überlauf: einmal stärker verdichten und neu versuchen", async () => {
    const big = "x".repeat(30_000);
    const p = new ScriptedProvider([{ error: AIError.http(400, "prompt is too long: 250000 tokens") }, { text: "summary of earlier" }, { text: "ok" }]);
    const history = Array.from({ length: 10 }, (_, i) => [{ role: "user" as const, content: `q${i} ${big}` }, { role: "assistant" as const, content: `a${i}` }]).flat();
    const events = await collect(runTurn(new ModelEngine({ provider: p, model: "m", contextWindow: 200_000 }), { prompt: "now", history }, never));
    const b = fold(events);
    expect(b.text).toBe("ok");
    expect(b.notices).toEqual(["Older messages were summarized to fit the context window."]);
    const last = p.seen[2]!;
    expect(last[0]!.content).toContain("# Earlier in this conversation (summary)\nsummary of earlier");
    expect(last.filter((m) => m.role === "user")).toHaveLength(6);
  });

  it("langes Gespräch wird vor dem Aufruf verdichtet (ohne Fehler)", async () => {
    const p = new ScriptedProvider([{ text: "sum" }, { text: "ok" }]);
    const history = Array.from({ length: 10 }, (_, i) => [{ role: "user" as const, content: `q${i} ` + "y".repeat(2000) }, { role: "assistant" as const, content: `a${i}` }]).flat();
    const events = await collect(runTurn(new ModelEngine({ provider: p, model: "m", contextWindow: 6000 }), { prompt: "now", history }, never));
    expect(fold(events).text).toBe("ok");
    expect(p.seen[1]![0]!.content).toContain("(summary)\nsum");
  });

  it("Fehler des Anbieters: der Turn endet mit failed und der Meldung", async () => {
    const p = new ScriptedProvider([{ error: AIError.http(401, "invalid key") }]);
    const events = await collect(runTurn(new ModelEngine({ provider: p, model: "m" }), { prompt: "x" }, never));
    expect(events.map((e) => e.type)).toEqual(["started", "failed"]);
    expect(events[1]).toEqual({ type: "failed", message: "HTTP 401: invalid key" });
  });

  it("Stop bricht ab: failed „Stopped.“ als letztes Ereignis, das Werkzeug läuft nicht weiter", async () => {
    const c = new AbortController();
    const p = new ScriptedProvider([{ text: "Working", calls: [{ id: "c1", name: "search", arguments: {} }] }, { text: "never" }]);
    const h = host([], () => new Promise<ToolResult>(() => undefined));
    const events: ChatEvent[] = [];
    for await (const e of runTurn(new ModelEngine({ provider: p, model: "m", tools: h, policy: { mode: "free" } }), { prompt: "x" }, c.signal)) {
      events.push(e);
      if (e.type === "toolUse") c.abort();
    }
    expect(events[events.length - 1]).toEqual({ type: "failed", message: "Stopped.", stopped: true });
    expect(p.seen).toHaveLength(1);
    expect(fold(events).parts.find((x) => x.kind === "tool")?.status).toBe("failed");
  });

  it("Schrittlimit endet mit einem Hinweis", async () => {
    const p = new ScriptedProvider(Array.from({ length: 3 }, (_, i) => ({ calls: [{ id: "c" + i, name: "search", arguments: {} }] })));
    const events = await collect(runTurn(new ModelEngine({ provider: p, model: "m", tools: host(), policy: { mode: "free" }, maxSteps: 2 }), { prompt: "x" }, never));
    expect(fold(events).notices).toEqual(["Stopped after 2 steps (step limit). Reply “continue” to keep going."]);
    expect(p.seen).toHaveLength(2);
  });

  it("Permission: „Ask before edits“ fragt nur bei Schreib-Werkzeugen; Ablehnen schreibt nichts", async () => {
    const calls: string[] = [];
    const asked: string[] = [];
    const run = async (mode: "ask" | "askEdits" | "free", answer: boolean | undefined) => {
      calls.length = 0;
      asked.length = 0;
      const p = new ScriptedProvider([{ calls: [{ id: "r", name: "search", arguments: {} }, { id: "w", name: "create_page", arguments: { title: "T" } }] }, { text: "ok" }]);
      const policy = answer === undefined ? { mode } : { mode, approve: async (c: { name: string }) => { asked.push(c.name); return answer; } };
      return collect(runTurn(new ModelEngine({ provider: p, model: "m", tools: host(calls), policy }), { prompt: "x" }, never));
    };
    let events = await run("askEdits", true);
    expect(asked).toEqual(["create_page"]);
    expect(calls).toHaveLength(2);
    expect(events.filter((e) => e.type === "permissionRequest")).toEqual([{ type: "permissionRequest", id: "w", name: "create_page" }]);
    events = await run("askEdits", false);
    expect(calls).toEqual(["search{}"]);
    expect(events.find((e) => e.type === "toolResult" && e.id === "w")).toEqual({ type: "toolResult", id: "w", output: "The user declined this action.", isError: true });
    await run("ask", true);
    expect(asked).toEqual(["search", "create_page"]);
    await run("free", false);
    expect(asked).toEqual([]);
    expect(calls).toHaveLength(2);
    // niemand da, den man fragen könnte: abgelehnt statt still ausgeführt
    events = await run("askEdits", undefined);
    expect(calls).toEqual(["search{}"]);
    expect(events.find((e) => e.type === "toolResult" && e.id === "w")).toMatchObject({ isError: true });
  });

  it("unbekanntes Werkzeug und werfendes Werkzeug werden Fehler-Ergebnisse", async () => {
    const emit: ChatEvent[] = [];
    const h = host([], () => { throw new Error("disk full"); });
    expect(await executeTool(h, { id: "1", name: "nope", arguments: {} }, { mode: "free" }, never, (e) => emit.push(e))).toEqual({ text: "Unknown tool nope", isError: true });
    expect(await executeTool(h, { id: "2", name: "search", arguments: {} }, { mode: "free" }, never, (e) => emit.push(e))).toEqual({ text: "disk full", isError: true });
    expect(emit).toEqual([]);
  });
});

describe("ScriptedEngine", () => {
  it("spielt Thinking, Text in Stücken und echte Werkzeug-Aufrufe ab", async () => {
    const calls: string[] = [];
    const engine = new ScriptedEngine({
      tools: host(calls),
      script: [{ thinking: "Looking at the request." }, { text: "Creating the page now.", chunk: 8 }, { tool: "create_page", input: { title: "Trip" } }, { text: "Done." }],
    });
    const events = await collect(runTurn(engine, { prompt: "make a page" }, never));
    expect(events.filter((e) => e.type === "textDelta").map((e) => e.type === "textDelta" && e.text)).toEqual(["Creating", " the pag", "e now.", "Done."]);
    expect(calls).toEqual(['create_page{"title":"Trip"}']);
    const b = fold(events);
    expect(b.parts.map((x) => x.kind)).toEqual(["thinking", "text", "tool", "text"]);
    expect(b.parts[2]).toMatchObject({ id: "call_0_1", status: "done", output: "create_page ok", detail: "Trip" });
    expect(events[events.length - 1]).toEqual({ type: "result", text: "Creating the page now.\n\nDone.", isError: false });
    expect(engine.requests).toEqual([{ prompt: "make a page" }]);
  });

  it("Skript je Turn; fail beendet mit failed", async () => {
    const engine = new ScriptedEngine({ script: (req, turn) => (turn === 0 ? [{ text: "echo " + req.prompt }] : [{ fail: "No credit left." }]) });
    expect(fold(await collect(runTurn(engine, { prompt: "a" }, never))).text).toBe("echo a");
    const second = await collect(runTurn(engine, { prompt: "b" }, never));
    expect(second[second.length - 1]).toEqual({ type: "failed", message: "No credit left." });
  });

  it("hold wartet auf Stop; danach kommt nichts mehr", async () => {
    const c = new AbortController();
    const engine = new ScriptedEngine({ script: [{ text: "Starting…" }, { hold: true }, { text: "never" }] });
    const events: ChatEvent[] = [];
    for await (const e of runTurn(engine, { prompt: "x" }, c.signal)) {
      events.push(e);
      if (e.type === "text") setTimeout(() => c.abort(), 0);
    }
    expect(events.map((e) => e.type)).toEqual(["started", "textDelta", "text", "failed"]);
    expect(events[3]).toMatchObject({ stopped: true });
  });

  it("Freigabe: die Anfrage erscheint, bevor die Antwort da ist", async () => {
    let allow: (ok: boolean) => void = () => undefined;
    const calls: string[] = [];
    const engine = new ScriptedEngine({ tools: host(calls), policy: { mode: "askEdits", approve: () => new Promise<boolean>((r) => { allow = r; }) }, script: [{ tool: "create_page", input: { title: "T" } }] });
    const events: ChatEvent[] = [];
    for await (const e of runTurn(engine, { prompt: "x" }, never)) {
      events.push(e);
      if (e.type === "permissionRequest") {
        expect(calls).toEqual([]);
        allow(true);
      }
    }
    expect(events.map((e) => e.type)).toEqual(["started", "toolUse", "permissionRequest", "toolResult", "result"]);
    expect(calls).toHaveLength(1);
  });
});
