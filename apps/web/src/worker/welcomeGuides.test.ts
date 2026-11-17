// BSD-305 Teil 5: Die Anleitung „Your data“ erwähnt AI nur in Builds, die AI anbieten (auf beta fehlt der Schalter).
import { describe, expect, it } from "vitest";
import { welcomeGuides } from "./welcomeGuides.js";

const text = (ai: boolean) => welcomeGuides(ai).flatMap((g) => g.lines.map((l) => l[1])).join("\n");

describe("welcomeGuides", () => {
  it("mit AI-Option: Satz über Agenten in „Your data“", () => {
    expect(text(true)).toMatch(/Agents only run/);
  });
  it("ohne AI-Option (beta): kein Wort über AI oder Agenten, sonst gleich", () => {
    expect(text(false)).not.toMatch(/\bAI\b|agent/i);
    expect(welcomeGuides(false).map((g) => g.title)).toEqual(welcomeGuides(true).map((g) => g.title));
    expect(welcomeGuides(false).find((g) => g.title === "Your data")!.lines.length).toBe(welcomeGuides(true).find((g) => g.title === "Your data")!.lines.length - 1);
  });
});
