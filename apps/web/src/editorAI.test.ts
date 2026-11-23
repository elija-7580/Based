import { describe, expect, it } from "vitest";
import { aiPrompt, cleanAIText, editorAI, EDITOR_AI_SYSTEM, personalSystem } from "./editorAI.js";

describe("Ask AI im Editor (BSD-225)", () => {
  it("Prompt mit Auswahl bzw. Seitenkontext", () => {
    expect(aiPrompt({ prompt: " Make shorter ", selection: "Long text", page: "ignored" })).toBe("Instruction: Make shorter\n\nSelected text:\nLong text");
    expect(aiPrompt({ prompt: "Write a list", page: "Groceries" })).toContain("The page so far (context only, do not repeat it):\nGroceries");
    expect(aiPrompt({ prompt: "Hi", page: "" })).toBe("Instruction: Hi");
    expect(aiPrompt({ prompt: "x", page: "y".repeat(10_000) }).length).toBeLessThan(4200);
  });
  it("entfernt einen umschließenden Codeblock, sonst nichts", () => {
    expect(cleanAIText("```markdown\n- a\n- b\n```")).toBe("- a\n- b");
    expect(cleanAIText("Text with `code`")).toBe("Text with `code`");
  });
  it("ruft die Engine mit System-Prompt und gesäubertem Ergebnis", async () => {
    const calls: string[] = [];
    const ai = editorAI(async (system, prompt) => { calls.push(system.slice(0, 10), prompt); return "```md\nDone\n```"; });
    expect(await ai.write({ prompt: "Go", page: "" }, new AbortController().signal)).toBe("Done");
    expect(calls[1]).toBe("Instruction: Go");
  });
});

describe("Ask AI knows the user (personal context)", () => {
  it("adds what the memory returns to the system prompt and passes the request as the query", async () => {
    const seen: { system: string; query?: string } = { system: "" };
    const ai = editorAI(async (system) => { seen.system = system; return "ok"; }, undefined, async (q) => { seen.query = q; return "How the user writes:\n- Short."; });
    await ai.write({ prompt: "Write an update", page: "Based notes" }, new AbortController().signal);
    expect(seen.system.startsWith(EDITOR_AI_SYSTEM)).toBe(true);
    expect(seen.system).toContain("- Short.");
    expect(seen.query).toContain("Write an update");
    expect(seen.query).toContain("Based notes");
  });

  it("writes without it when the memory is empty or fails", async () => {
    for (const personal of [async () => "", async () => { throw new Error("worker gone"); }]) {
      let system = "";
      await editorAI(async (s) => { system = s; return "ok"; }, undefined, personal).write({ prompt: "x", page: "" }, new AbortController().signal);
      expect(system).toBe(EDITOR_AI_SYSTEM);
    }
    expect(personalSystem("  ")).toBe(EDITOR_AI_SYSTEM);
  });
});
