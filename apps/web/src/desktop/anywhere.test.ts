// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { describe, expect, it } from "vitest";
import { actionsFor, answerAnywhere, ANYWHERE_SYSTEM, anywherePrompt, EMPTY_CONTEXT, isAnywhereWindow, type AnywhereService } from "./anywhere.js";

const ctx = (p: Partial<typeof EMPTY_CONTEXT>) => ({ ...EMPTY_CONTEXT, ...p });

function service(o: Partial<AnywhereService> & { seen?: { system: string; prompt: string }[] } = {}): AnywhereService {
  return {
    enabled: () => true, subscribe: () => () => undefined,
    personal: async () => "",
    write: async (system, prompt) => { o.seen?.push({ system, prompt }); return " Sure, Friday works. "; },
    ...o,
  };
}

describe("write anywhere: what goes to the model", () => {
  it("names the app and sends the selection, or else the field, as context", () => {
    expect(anywherePrompt(" Reply ", ctx({ app: "Mail", title: "Re: Friday", text: "Can we meet Friday?" })))
      .toBe("Instruction: Reply\n\nApp: Mail – Re: Friday\n\nText in the field so far (context only, do not repeat it):\nCan we meet Friday?");
    const p = anywherePrompt("Improve", ctx({ app: "Notes", text: "whole field", selection: "just this" }));
    expect(p).toContain("Selected text (your answer replaces it):\njust this");
    expect(p).not.toContain("whole field");
    expect(anywherePrompt("Write a haiku", EMPTY_CONTEXT)).toBe("Instruction: Write a haiku");
  });

  it("offers only the quick actions that fit what was read", () => {
    expect(actionsFor(EMPTY_CONTEXT)).toEqual([]);
    expect(actionsFor(ctx({ text: "Hello" })).map((a) => a.id)).toEqual(["reply", "continue"]);
    expect(actionsFor(ctx({ text: "Hello", selection: "Hel" })).map((a) => a.id)).toEqual(["improve", "shorter"]);
  });

  it("recognises its own window", () => {
    expect(isAnywhereWindow("?window=anywhere")).toBe(true);
    expect(isAnywhereWindow("?window=meeting-prompt")).toBe(false);
    expect(isAnywhereWindow("")).toBe(false);
  });
});

describe("write anywhere: answering a request", () => {
  const ask = { id: "1", instruction: "Reply that Friday works", context: ctx({ app: "Mail", text: "Can we meet Friday?" }) };

  it("writes with what the memory knows and returns trimmed text", async () => {
    const seen: { system: string; prompt: string }[] = [];
    const a = await answerAnywhere(ask, service({ seen, personal: async (q) => (q.includes("Friday") ? "How the user writes:\n- Short." : "") }), new AbortController().signal);
    expect(a).toEqual({ id: "1", text: "Sure, Friday works." });
    expect(seen[0]!.system.startsWith(ANYWHERE_SYSTEM)).toBe(true);
    expect(seen[0]!.system).toContain("- Short.");
    expect(seen[0]!.prompt).toContain("App: Mail");
  });

  it("works without memory, and when looking it up fails", async () => {
    const seen: { system: string; prompt: string }[] = [];
    await answerAnywhere(ask, service({ seen, personal: async () => { throw new Error("worker gone"); } }), new AbortController().signal);
    expect(seen[0]!.system).toBe(ANYWHERE_SYSTEM);
  });

  it("sends placeholders when redaction is on and puts the values back", async () => {
    const seen: { system: string; prompt: string }[] = [];
    const a = await answerAnywhere(ask, service({
      seen, write: async (system, prompt) => { seen.push({ system, prompt }); return "See you <DAY_1>."; },
      redact: async () => ({ out: (s) => s.replaceAll("Friday", "<DAY_1>"), back: (s) => s.replaceAll("<DAY_1>", "Friday") }),
    }), new AbortController().signal);
    expect(seen[0]!.prompt).not.toContain("Friday");
    expect(a.text).toBe("See you Friday.");
  });

  it("says what went wrong: empty instruction, no model, empty answer, stopped", async () => {
    const signal = new AbortController().signal;
    expect((await answerAnywhere({ ...ask, instruction: "  " }, service(), signal)).error).toBe("Tell Based what to write.");
    expect((await answerAnywhere(ask, service({ write: async () => { throw new Error("No model is set up."); } }), signal)).error).toBe("No model is set up.");
    expect((await answerAnywhere(ask, service({ write: async () => "  " }), signal)).error).toBe("The model returned nothing. Try again.");
    const abort = new AbortController();
    const stopped = answerAnywhere(ask, service({ write: async () => { abort.abort(); throw new Error("aborted"); } }), abort.signal);
    expect((await stopped).error).toBe("Stopped.");
  });
});
