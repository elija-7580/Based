import { describe, expect, it } from "vitest";
import { chatEvent, ChatTurnBuilder, compactEvents, foldTranscript, parseChatEvents, toolSummary, type ChatEvent, type StoredChatEvent } from "../src/index.js";

const fold = (events: readonly StoredChatEvent[]) => {
  const b = new ChatTurnBuilder();
  for (const e of events) b.apply(e);
  return b;
};

/** Ein Modell-Schritt wie ihn die ModelEngine schickt. */
const step = (thinking: string, text: string, tools: { id: string; name: string; input: Record<string, string>; output: string; isError?: boolean }[] = []): ChatEvent[] => [
  ...(thinking ? thinking.split(" ").map((w): ChatEvent => ({ type: "thinkingDelta", text: w + " " })) : []),
  ...(text ? text.split(" ").map((w): ChatEvent => ({ type: "textDelta", text: w + " " })) : []),
  ...tools.flatMap((t): ChatEvent[] => [{ type: "toolStart", id: t.id, name: t.name }, { type: "toolInputDelta", id: t.id, json: JSON.stringify(t.input) }]),
  { type: "usage", inputTokens: 10, outputTokens: 5, costUSD: 0.001, estimated: true, model: "fake/m" },
  ...(thinking ? [{ type: "thinking", text: thinking } as ChatEvent] : []),
  ...(text ? [{ type: "text", text } as ChatEvent] : []),
  ...tools.flatMap((t): ChatEvent[] => [
    { type: "toolUse", id: t.id, name: t.name, input: t.input },
    { type: "toolResult", id: t.id, output: t.output, isError: t.isError ?? false },
  ]),
];

describe("ChatTurnBuilder", () => {
  it("Deltas werden zu Teilen, fertige Blöcke ersetzen sie", () => {
    const b = fold([
      { type: "started", model: "fake/m" },
      ...step("let me look", "I will search.", [{ id: "t1", name: "search", input: { query: "trip" }, output: "- Trip (id: p1)" }]),
      ...step("", "Found it."),
      { type: "result", text: "Found it.", isError: false },
    ]);
    expect(b.parts.map((p) => [p.id, p.kind, p.status, p.provisional])).toEqual([
      ["th1", "thinking", "done", false], ["tx2", "text", "done", false], ["t1", "tool", "done", false], ["tx3", "text", "done", false],
    ]);
    expect(b.parts[0]!.text).toBe("let me look");
    expect(b.parts[2]).toMatchObject({ toolName: "search", detail: "trip", output: "- Trip (id: p1)", input: { query: "trip" } });
    expect(b.parts[2]!.inputJSON).toBeUndefined();
    expect(b.text).toBe("I will search.\n\nFound it.");
    expect(b.model).toBe("fake/m");
    expect(b.usage).toEqual({ inputTokens: 20, outputTokens: 10, costUSD: 0.002, estimated: true });
    expect(b.done && !b.isError).toBe(true);
  });

  it("Thinking läuft, bis Text kommt; Tool-Karte zeigt gestreamte Eingabe", () => {
    const b = new ChatTurnBuilder();
    b.apply({ type: "thinkingDelta", text: "hm" });
    expect(b.isThinking).toBe(true);
    b.apply({ type: "textDelta", text: "ok" });
    expect(b.isThinking).toBe(false);
    b.apply({ type: "toolStart", id: "c", name: "create_page" });
    b.apply({ type: "toolInputDelta", id: "c", json: '{"title":' });
    expect(b.parts[2]).toMatchObject({ kind: "tool", status: "running", toolName: "create_page", inputJSON: '{"title":' });
    b.apply({ type: "toolUse", id: "c", name: "create_page", input: { title: "Trip" } });
    b.apply({ type: "permissionRequest", id: "c", name: "create_page" });
    expect(b.parts[2]!.status).toBe("waiting");
    b.apply({ type: "toolResult", id: "c", output: "The user declined this action.", isError: true });
    expect(b.parts[2]!.status).toBe("failed");
    expect(b.parts).toHaveLength(3);
  });

  it("Abbruch: laufende Teile schließen, Tools scheitern, Meldung bleibt getrennt vom Text", () => {
    const b = fold([{ type: "textDelta", text: "Half an ans" }, { type: "toolUse", id: "t", name: "search", input: {} }, { type: "failed", message: "Stopped.", stopped: true }]);
    expect(b.parts.map((p) => p.status)).toEqual(["done", "failed"]);
    expect(b.text).toBe("Half an ans");
    expect(b).toMatchObject({ error: "Stopped.", stopped: true, isError: true, done: true });
  });

  it("result ohne Textteil liefert den Text; Fehler-result nicht", () => {
    expect(fold([{ type: "result", text: "(done)", isError: false }]).parts.map((p) => p.text)).toEqual(["(done)"]);
    expect(fold([{ type: "result", text: "boom", isError: true }]).parts).toEqual([]);
  });

  it("fortgesetzter Text bleibt ein Teil (Hinweis dazwischen)", () => {
    const b = fold([
      { type: "thinkingDelta", text: "hmm" }, { type: "textDelta", text: "Part one," },
      { type: "notice", text: "The answer hit the length limit and was continued." },
      { type: "textDelta", text: " part two." }, { type: "thinking", text: "hmm" }, { type: "text", text: "Part one, part two." },
    ]);
    expect(b.parts.filter((p) => p.kind === "text").map((p) => p.text)).toEqual(["Part one, part two."]);
    expect(b.parts.filter((p) => p.kind === "thinking")).toHaveLength(1);
    expect(b.notices).toEqual(["The answer hit the length limit and was continued."]);
  });

  it("unbekannte Ereignisse neuerer Versionen werden übersprungen, bleiben aber erhalten", () => {
    const stored = parseChatEvents([{ type: "text", text: "a", extra: 1 }, { type: "hologram", data: [1, 2] }, { type: "text" }, "junk", { type: "toolResult", id: "x", output: "o", isError: false }]);
    expect(stored).toEqual([{ type: "text", text: "a", extra: 1 }, { type: "hologram", data: [1, 2] }, { type: "toolResult", id: "x", output: "o", isError: false }]);
    expect(fold(stored).parts.map((p) => p.text)).toEqual(["a"]);
    expect(compactEvents(stored)).toEqual(stored);
  });

  it("toolSummary nimmt das sprechendste Argument", () => {
    expect(toolSummary({ page_id: "p1", query: "notes" })).toBe("notes");
    expect(toolSummary({ zeta: "z", alpha: "a\nb" })).toBe("a\nb".slice(0, 160));
    expect(toolSummary({ title: "Line\nbreak" })).toBe("Line break");
    expect(toolSummary("x")).toBe("");
  });

  it("Schema: jedes Ereignis parst und bleibt unverändert", () => {
    const all: ChatEvent[] = [
      { type: "started", model: "m", sessionID: "s" }, { type: "userMessage", text: "hi", at: 1 }, { type: "thinkingDelta", text: "a" }, { type: "textDelta", text: "b" },
      { type: "thinking", text: "a" }, { type: "text", text: "b" }, { type: "toolStart", id: "1", name: "n" }, { type: "toolInputDelta", id: "1", json: "{" },
      { type: "toolUse", id: "1", name: "n", input: { a: [1, null, { b: true }] } }, { type: "permissionRequest", id: "1", name: "n" },
      { type: "toolResult", id: "1", output: "o", isError: false }, { type: "usage", inputTokens: 1, outputTokens: 2, costUSD: 0.1, estimated: true, model: "m" },
      { type: "notice", text: "n" }, { type: "failed", message: "x", stopped: true }, { type: "result", text: "t", sessionID: "s", costUSD: 1, isError: false },
    ];
    for (const e of all) expect(chatEvent.parse(e)).toEqual(e);
    expect(() => chatEvent.parse({ type: "text" })).toThrow();
  });
});

describe("compactEvents", () => {
  const shape = (b: ChatTurnBuilder) => b.parts.map((p) => ({ id: p.id, kind: p.kind, text: p.text, status: p.status, toolName: p.toolName, detail: p.detail, input: p.input, inputJSON: p.inputJSON, output: p.output, provisional: p.provisional }));

  it("fertiger Turn: nur fertige Blöcke bleiben", () => {
    const events: ChatEvent[] = [{ type: "started", model: "m" }, ...step("think hard", "one two three", [{ id: "t1", name: "search", input: { query: "q" }, output: "r" }]), ...step("", "done"), { type: "result", text: "done", isError: false }];
    const c = compactEvents(events);
    expect(c.map((e) => e.type)).toEqual(["started", "thinking", "text", "toolUse", "usage", "toolResult", "text", "usage", "result"]);
    expect(shape(fold(c))).toEqual(shape(fold(events)));
  });

  it("abgebrochener Turn: Deltas bleiben als ein Ereignis je Block", () => {
    const events: ChatEvent[] = [{ type: "thinkingDelta", text: "a" }, { type: "thinkingDelta", text: "b" }, { type: "textDelta", text: "x" }, { type: "textDelta", text: "y" }, { type: "toolStart", id: "t", name: "search" }, { type: "toolInputDelta", id: "t", json: "{" }, { type: "failed", message: "Stopped.", stopped: true }];
    const c = compactEvents(events);
    expect(c).toEqual([{ type: "thinkingDelta", text: "ab" }, { type: "textDelta", text: "xy" }, { type: "toolStart", id: "t", name: "search" }, { type: "toolInputDelta", id: "t", json: "{" }, { type: "failed", message: "Stopped.", stopped: true }]);
    expect(shape(fold(c))).toEqual(shape(fold(events)));
  });

  it("ist idempotent und ändert das gefaltete Ergebnis nie (zufällige Turns, jeder Präfix)", () => {
    let seed = 7;
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const word = () => ["alpha", "beta", "gamma", "delta"][rnd(4)]!;
    for (let round = 0; round < 60; round++) {
      const events: ChatEvent[] = [{ type: "userMessage", text: "q" }, { type: "started", model: "m" }];
      const steps = 1 + rnd(4);
      for (let s = 0; s < steps; s++) {
        const tools = Array.from({ length: rnd(3) }, (_, i) => ({ id: `t${round}_${s}_${i}`, name: "search", input: { query: word() }, output: word(), isError: rnd(4) === 0 }));
        const st = step(rnd(2) ? `${word()} ${word()}` : "", rnd(3) ? `${word()} ${word()} ${word()}` : "", tools);
        if (rnd(4) === 0) st.splice(rnd(st.length), 0, { type: "notice", text: "n" });
        if (rnd(5) === 0 && tools.length > 0) st.splice(st.findIndex((e) => e.type === "toolUse") + 1, 0, { type: "permissionRequest", id: tools[0]!.id, name: "search" });
        events.push(...st);
      }
      events.push(rnd(3) === 0 ? { type: "failed", message: "x" } : { type: "result", text: "", isError: false });
      for (let n = 1; n <= events.length; n++) {
        const prefix = events.slice(0, n);
        const c = compactEvents(prefix);
        expect(compactEvents(c)).toEqual(c);
        expect(c.length).toBeLessThanOrEqual(prefix.length);
        const a = foldTranscript(prefix), b = foldTranscript(c);
        expect(b.items.map((i) => (i.kind === "assistant" ? shape(i.turn) : i.text))).toEqual(a.items.map((i) => (i.kind === "assistant" ? shape(i.turn) : i.text)));
        expect(b.usage).toEqual(a.usage);
      }
    }
  });
});

describe("foldTranscript", () => {
  it("mehrere Turns, Summen über den Chat", () => {
    const t = foldTranscript([
      { type: "userMessage", text: "first", at: 5 }, ...step("", "one"), { type: "result", text: "one", isError: false },
      { type: "userMessage", text: "second" }, { type: "userMessage", text: "third (queued)" }, ...step("", "two"), { type: "failed", message: "boom" },
      { type: "userMessage", text: "fourth" }, { type: "textDelta", text: "stream" },
    ]);
    expect(t.items.map((i) => i.kind + ":" + i.id)).toEqual(["user:u1", "assistant:a2", "user:u3", "user:u4", "assistant:a5", "user:u6", "assistant:a7"]);
    expect(t.items[0]).toMatchObject({ text: "first", at: 5 });
    expect(t.usage).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expect(t.usage.costUSD).toBeCloseTo(0.002);
    expect(t.openTurn?.parts[0]?.text).toBe("stream");
    const failed = t.items[4];
    expect(failed?.kind === "assistant" && failed.turn.error).toBe("boom");
  });

  it("Kosten, die nur die Engine meldet (result.costUSD), zählen mit", () => {
    const t = foldTranscript([{ type: "userMessage", text: "q" }, { type: "text", text: "a" }, { type: "result", text: "a", costUSD: 0.25, isError: false }]);
    expect(t.usage.costUSD).toBe(0.25);
  });
});
