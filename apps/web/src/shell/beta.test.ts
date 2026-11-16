// Beta-Gate: was der Kanal „beta“ ausblendet – in ⌘K, Seitenleiste, Slash-Menü und Routen.
import { describe, expect, it } from "vitest";
import { slashItemsFor } from "@based/editor";
import { BETA_HIDDEN, CHANNEL, commandVisible, featureVisible, hiddenBlockTypes } from "./beta.js";
import { matchCommands, navAvailable, NAV_COMMANDS } from "./sidebarNav.js";

describe("Beta-Gate", () => {
  it("ohne Build-Schalter ist der Kanal dev und alles sichtbar", () => {
    expect(CHANNEL).toBe("dev");
    for (const f of Object.keys(BETA_HIDDEN) as (keyof typeof BETA_HIDDEN)[]) expect(featureVisible(f)).toBe(true);
    expect(hiddenBlockTypes().size).toBe(0);
  });

  it("beta blendet Meetings, Graph, Echtzeit-Text und Coding aus", () => {
    expect(featureVisible("meetings", "beta")).toBe(false);
    expect(featureVisible("graph", "beta")).toBe(false);
    expect(featureVisible("realtimeText", "beta")).toBe(false);
    expect(featureVisible("coding", "beta")).toBe(false);
    for (const id of ["meetings", "meeting", "graph", "coding"]) expect(commandVisible(id, "beta")).toBe(false);
    for (const id of ["home", "library", "trash", "settings", "report"]) expect(commandVisible(id, "beta")).toBe(true);
  });

  it("⌘K bietet auf beta keine ausgeblendeten Befehle an, in dev schon", () => {
    const ids = (q: string, channel: "dev" | "beta") => matchCommands(q, { ai: false, channel }).map((c) => c.id);
    expect(ids("meet", "beta")).toEqual([]);
    expect(ids("graph", "beta")).toEqual([]);
    expect(ids("meet", "dev")).toEqual(expect.arrayContaining(["meetings", "meeting"]));
    expect(ids("lib", "beta")).toEqual(["library"]);
    expect(ids("report", "beta")).toEqual(["report"]);
    // jeder Befehl ist entweder sichtbar oder steht für eine ausgeblendete Funktion
    expect(NAV_COMMANDS.filter((c) => !commandVisible(c.id, "beta")).map((c) => c.id).sort()).toEqual(["coding", "graph", "meeting", "meetings"]);
  });

  it("Seitenleiste: Graph und Coding erscheinen auf beta auch angepinnt nicht", () => {
    expect(navAvailable("graph", { advanced: true, channel: "beta" })).toBe(false);
    expect(navAvailable("coding", { advanced: true, channel: "beta" })).toBe(false);
    expect(navAvailable("library", { advanced: false, channel: "beta" })).toBe(true);
    expect(navAvailable("graph", { advanced: false, channel: "dev" })).toBe(true);
  });

  it("Slash-Menü: auf beta kein „Meeting notes“, sonst unverändert", () => {
    const beta = slashItemsFor(false, hiddenBlockTypes("beta")).map((s) => s.label);
    const dev = slashItemsFor(false, hiddenBlockTypes("dev")).map((s) => s.label);
    expect(dev).toContain("Meeting notes");
    expect(beta).not.toContain("Meeting notes");
    expect(beta.length).toBe(dev.length - 1);
    expect(slashItemsFor(true, hiddenBlockTypes("beta"))[0]?.label).toBe("Ask AI");
  });
});
