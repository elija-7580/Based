import { describe, expect, it } from "vitest";
import { aiPrompt, cleanAIText, editorAI } from "./editorAI.js";

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
