import { describe, expect, it } from "vitest";
import { iconAsText, parsePhosphorIcon, phosphorIcon } from "../src/index.js";

describe("BSD-376: Phosphor-Icon-Referenz", () => {
  it("schreibt und liest phosphor:<name>:<farbe>", () => {
    expect(phosphorIcon("rocket-launch", "blue")).toBe("phosphor:rocket-launch:blue");
    expect(parsePhosphorIcon("phosphor:rocket-launch:blue")).toEqual({ name: "rocket-launch", color: "blue" });
  });
  it("unbekannte Farbe → grau, fehlerhafter Name → kein Icon", () => {
    expect(parsePhosphorIcon("phosphor:rocket:teal")).toEqual({ name: "rocket", color: "gray" });
    expect(parsePhosphorIcon("phosphor:rocket")).toEqual({ name: "rocket", color: "gray" });
    expect(parsePhosphorIcon("phosphor:<svg>:blue")).toBeUndefined();
    expect(parsePhosphorIcon("🚀")).toBeUndefined();
    expect(parsePhosphorIcon("doc.text")).toBeUndefined();
    expect(parsePhosphorIcon({ emoji: "🚀" })).toBeUndefined();
  });
  it("Export schreibt Phosphor nicht als Text", () => {
    expect(iconAsText("phosphor:rocket:blue")).toBeUndefined();
    expect(iconAsText("🚀")).toBe("🚀");
  });
});
