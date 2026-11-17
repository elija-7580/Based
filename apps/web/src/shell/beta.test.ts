// Beta-Gate: was der Kanal „beta“ ausblendet – in ⌘K, Seitenleiste, Slash-Menü und Routen.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { slashItemsFor } from "@based/editor";
import { BETA_HIDDEN, BETA_HIDDEN_SETTINGS, CHANNEL, commandVisible, featureVisible, hiddenBlockTypes, productBlurb, productName, settingsPageVisible } from "./beta.js";
import { SETTINGS_PAGES } from "./settings.js";
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
    expect(featureVisible("sharing", "beta")).toBe(false);
    expect(featureVisible("whiteboard", "beta")).toBe(false);
    for (const id of ["meetings", "meeting", "graph", "coding", "board"]) expect(commandVisible(id, "beta")).toBe(false);
    expect(commandVisible("board", "dev")).toBe(true);
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

describe("Beta-Gate: Einstellungen", () => {
  it("blendet AI-/Agenten-Seiten nur auf beta aus", () => {
    for (const id of ["agents", "connections", "notifications"]) {
      expect(settingsPageVisible(id, "beta"), id).toBe(false);
      expect(settingsPageVisible(id, "dev"), id).toBe(true);
    }
    for (const id of ["my-settings", "import", "sync", "updates", "diagnostics", "about"]) expect(settingsPageVisible(id, "beta"), id).toBe(true);
    expect(BETA_HIDDEN_SETTINGS.size).toBe(7);
  });

  it("BSD-460: „Not yet“-Seiten ohne eigene Einstellungen fehlen auf beta, in dev bleiben sie", () => {
    for (const id of ["my-connections", "people", "teamspaces", "security"]) {
      expect(settingsPageVisible(id, "beta"), id).toBe(false);
      expect(settingsPageVisible(id, "dev"), id).toBe(true);
    }
    const beta = SETTINGS_PAGES.filter((p) => settingsPageVisible(p.id, "beta")).map((p) => p.id);
    expect(beta).toEqual(["account", "my-settings", "language", "workspace", "import", "sync", "billing", "updates", "diagnostics", "about"]);
    expect(SETTINGS_PAGES.filter((p) => settingsPageVisible(p.id, "dev")).length).toBe(SETTINGS_PAGES.length);
  });
});

describe("Beta-Gate: Agenten-Markierungen (BSD-459)", () => {
  it("Marker und Calm mode nur auf beta ausgeblendet", () => {
    expect(featureVisible("agentMarks", "beta")).toBe(false);
    expect(featureVisible("agentMarks", "dev")).toBe(true);
  });
});

describe("Beta-Gate: Teilen (BSD-460)", () => {
  it("Share ist nur auf beta ausgeblendet", () => {
    expect(featureVisible("sharing", "beta")).toBe(false);
    expect(featureVisible("sharing", "dev")).toBe(true);
    expect(BETA_HIDDEN.sharing).toMatch(/after/);
  });
});

// BSD-471: replica/features.csv Spalte „beta“ zeigt nur, was auf beta gebaut und sichtbar ist. Release Notes,
// Website-Abgleich (docs/website-claims.md) und Planung zählen mit dieser Spalte.
describe("features.csv passt zum Beta-Gate", () => {
  const rows = readFileSync(new URL("../../../../replica/features.csv", import.meta.url), "utf8").trim().split("\n").slice(1).map((line) => {
    const cells: string[] = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      if (quoted) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { cells.push(cur); cur = ""; } else cur += c;
    }
    cells.push(cur);
    return { feature: cells[0]!, area: cells[1]!, ts: cells[6]!, beta: cells[7]! };
  });
  const beta = rows.filter((r) => r.beta === "beta");

  it("jede Zeile hat 8 Spalten und einen bekannten Wert in beta", () => {
    expect(rows.length).toBeGreaterThan(200);
    for (const r of rows) expect(["beta", "labs", "after", ""], r.feature).toContain(r.beta);
  });

  it("keine beta-Zeile ist ungebaut (ts = no)", () => {
    expect(beta.filter((r) => /^no\b/.test(r.ts)).map((r) => r.feature)).toEqual([]);
  });

  it("keine AI-/Agenten-Zeile auf beta – der AI-Schalter fehlt dort (shell/ai.ts)", () => {
    expect(beta.filter((r) => r.area === "ai" || r.area === "agents").map((r) => r.feature)).toEqual([]);
  });

  it("ausgeblendete Funktionen stehen nicht auf beta", () => {
    const hidden = ["AI meeting notes (/meet)", "Real-time multi-user collaboration", "Sharing and permissions", "Coding-agent sessions (Happier / ACP)"];
    for (const f of hidden) expect(rows.find((r) => r.feature === f)?.beta, f).not.toBe("beta");
  });

  it("Über-Seite: beta heißt „Based Beta“ und nennt keine Agenten, dev bleibt „Based Next“ (BSD-485)", () => {
    expect(productName("beta")).toBe("Based Beta");
    expect(productBlurb("beta")).not.toMatch(/agent/i);
    expect(productName("dev")).toBe("Based Next");
    expect(productBlurb("dev")).toMatch(/agents/);
    expect(SETTINGS_PAGES.find((p) => p.id === "about")?.summary).toBe("Based Next — the notes app that keeps your data yours.");
  });
});
