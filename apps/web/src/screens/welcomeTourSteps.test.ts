// BSD-551: Schritte und Texte des Einstiegs.
import { describe, expect, it } from "vitest";
import { skipTarget, stepAfter, tourStepText, tourSteps, type TourEnv } from "./welcomeTourSteps.js";

const mac: TourEnv = { mac: true, meetings: true };
const allText = (env: TourEnv) => tourSteps(env).filter((s) => s !== "start")
  .map((s) => tourStepText(s as Exclude<typeof s, "start">, env)).flatMap((t) => [t.title, t.lead, ...t.points.flatMap((p) => [p.title, p.text])]).join("\n");

describe("welcomeTour", () => {
  it("fünf Schritte in der Mac-App; ohne Meetings vier; Wiederaufruf ohne die Wahl", () => {
    expect(tourSteps(mac)).toEqual(["welcome", "data", "meetings", "beta", "start"]);
    expect(tourSteps({ mac: true, meetings: false })).toEqual(["welcome", "data", "beta", "start"]);
    expect(tourSteps({ ...mac, revisit: true })).toEqual(["welcome", "data", "meetings", "beta"]);
  });

  it("Weiter, Zurück und Skip", () => {
    const s = tourSteps(mac);
    expect(stepAfter(s, "welcome", 1)).toBe("data");
    expect(stepAfter(s, "welcome", -1)).toBe("welcome");
    expect(stepAfter(s, "start", 1)).toBe("start");
    expect(stepAfter(s, "start", -1)).toBe("beta");
    expect(stepAfter(tourSteps({ mac: true, meetings: false }), "meetings", 1)).toBe("welcome");
    expect(skipTarget(mac)).toBe("start");
    expect(skipTarget({ ...mac, revisit: true })).toBeUndefined();
  });

  it("kein Wort über AI oder Agenten (auf beta gibt es sie nicht)", () => {
    for (const env of [mac, { mac: false, meetings: false }]) expect(allText(env)).not.toMatch(/\bAI\b|agent/i);
  });

  it("sagt, was Elija entschieden hat: Daten auf dem Mac, Backups, Export, Beta, ⇧⌘B und Mail", () => {
    const t = allText(mac);
    expect(tourStepText("welcome", mac).title).toBe("Welcome to Based Notes");
    expect(tourStepText("data", mac).title).toBe("Your data stays on this Mac");
    expect(t).toMatch(/before it installs an update/);
    expect(t).toMatch(/every hour/);
    expect(t).toMatch(/Export a page or the whole workspace/);
    expect(t).toMatch(/hello@basednotes\.app/);
    expect(tourStepText("beta", mac).points.find((p) => p.keys === "Mod+Shift+B")).toBeTruthy();
    // BSD-646: ⇧⌘B schickt den Bericht mit einem Klick (BSD-632) – nicht mehr „saves a report“
    for (const env of [mac, { mac: false, meetings: false }]) {
      const report = tourStepText("beta", env).points.find((p) => p.keys === "Mod+Shift+B")!.text;
      expect(report).toMatch(/sends .* in one click/);
      expect(report).not.toMatch(/saves a report/);
    }
    expect(tourStepText("welcome", mac).points.map((p) => p.keys)).toEqual(["/", undefined, "Mod+K"]);
  });

  it("im Browser: kein Mac, keine Backups über den lokalen Server, keine Fenster", () => {
    const web: TourEnv = { mac: false, meetings: false };
    expect(tourStepText("data", web).title).toBe("Your data stays on this device");
    expect(allText(web)).not.toMatch(/Mac|every hour|Help →/);
    expect(tourStepText("beta", web).points[0]!.text).not.toMatch(/meeting/);
  });

  it("kurz: jeder Text höchstens zwei Sätze, keine Gedankenstriche", () => {
    for (const env of [mac, { mac: false, meetings: false }]) {
      for (const s of ["welcome", "data", "meetings", "beta"] as const) {
        const t = tourStepText(s, env);
        for (const x of [t.lead, ...t.points.map((p) => p.text)]) {
          expect(x, x).not.toMatch(/ – | — /);
          expect(x.split(/(?<=[.?!])\s/).length, x).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});
