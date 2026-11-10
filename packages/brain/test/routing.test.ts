// BSD-242: Modellwahl Low/Auto/High (Regeln wie Swift `ModelRouter`, API-Modelle).
import { describe, expect, it } from "vitest";
import { modelTier, resolveTier, routeModel, ruleRoute } from "../src/index.js";

const models = [
  { ref: "anthropic/claude-haiku-4-5" }, { ref: "anthropic/claude-sonnet-4-5" }, { ref: "anthropic/claude-opus-4-5" },
  { ref: "openai/gpt-4.1-mini" }, { ref: "ollama/llama3.1:8b", onDevice: true },
];

describe("Modellwahl", () => {
  it("Stufen aus Modellnamen", () => {
    expect(modelTier("claude-haiku-4-5")).toBe(0);
    expect(modelTier("claude-sonnet-4-5")).toBe(1);
    expect(modelTier("claude-opus-4-5")).toBe(2);
    expect(modelTier("gpt-5")).toBe(2);
    expect(modelTier("gpt-4.1-mini")).toBe(0);
  });

  it("Regeln: Code, Recherche, Zusammenfassung, Schreiben, kurze Frage, langes Dokument, Hintergrund", () => {
    expect(ruleRoute({ text: "fix the bug in the repo" })?.id).toBe("code");
    expect(ruleRoute({ text: "refactor this", folder: "/p" })?.id).toBe("code");
    expect(ruleRoute({ text: "Recherchiere aktuelle Preise" })?.id).toBe("research");
    expect(ruleRoute({ text: "Fasse diese Seite zusammen" })?.id).toBe("quick");
    expect(ruleRoute({ text: "Schreib einen Brief an die Bank" })?.id).toBe("write");
    expect(ruleRoute({ text: "Wie spät ist es in Tokio?" })).toEqual({ id: "quick", reason: "short question" });
    expect(ruleRoute({ text: "x", attachmentChars: 200_000 })?.id).toBe("long");
    expect(ruleRoute({ text: "x", scheduled: true })?.id).toBe("background");
    expect(ruleRoute({ text: "Plan my week with the projects and their next steps" })).toBeUndefined();
  });

  it("Low = kleinstes, High = stärkstes, Auto nach Aufgabe; Anbieter des Standardmodells zuerst", () => {
    const d = { defaultModel: "anthropic/claude-sonnet-4-5" };
    expect(routeModel({ text: "Wie spät ist es?" }, "auto", models, d).model).toBe("anthropic/claude-haiku-4-5");
    expect(routeModel({ text: "Plan the quarter with all projects, budgets and milestones in detail" }, "auto", models, d).model).toBe("anthropic/claude-sonnet-4-5");
    expect(routeModel({ text: "Plan the quarter" }, "high", models, d).model).toBe("anthropic/claude-opus-4-5");
    expect(routeModel({ text: "Plan the quarter" }, "low", models, d).model).toBe("anthropic/claude-haiku-4-5");
    expect(routeModel({ text: "implement the parser in the repo" }, "auto", models, d).model).toBe("anthropic/claude-opus-4-5");
    expect(resolveTier("@small", models, "openai/gpt-4.1-mini")).toBe("openai/gpt-4.1-mini");
  });

  it("manuelle Wahl gewinnt, Budget erzwingt Low, fehlende Anbieter: nächste Stufe bzw. Standard", () => {
    expect(routeModel({ text: "anything" }, "high", models, { manual: "openai/gpt-4.1-mini" })).toMatchObject({ model: "openai/gpt-4.1-mini", manual: true });
    const low = routeModel({ text: "Plan the quarter" }, "high", models, { defaultModel: "anthropic/claude-sonnet-4-5", forceLow: true });
    expect(low).toMatchObject({ level: "low", model: "anthropic/claude-haiku-4-5" });
    expect(low.reason).toContain("budget exceeded");
    const onlySonnet = [{ ref: "anthropic/claude-sonnet-4-5" }];
    expect(routeModel({ text: "Plan" }, "high", onlySonnet).model).toBe("anthropic/claude-sonnet-4-5");
    expect(routeModel({ text: "Wie spät?" }, "low", [{ ref: "ollama/llama3.1:8b", onDevice: true }]).model).toBe("ollama/llama3.1:8b");
    expect(routeModel({ text: "x" }, "auto", []).model).toBeUndefined();
    expect(routeModel({ text: "Plan" }, "auto", models, { defaultModel: "anthropic/claude-sonnet-4-5" }).fallbacks).toEqual([]);
  });
});
