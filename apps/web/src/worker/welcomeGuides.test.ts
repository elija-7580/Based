// BSD-305 Teil 5: Die Anleitung „Your data“ erwähnt AI nur in Builds, die AI anbieten (auf beta fehlt der Schalter).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BETA_HIDDEN } from "../shell/beta.js";
import { everythingGuide, EVERYTHING, EVERYTHING_INTERNAL, welcomeGuides } from "./welcomeGuides.js";

/** replica/features.csv als Zeilen (Felder in Anführungszeichen dürfen Kommas und Zeilenumbrüche enthalten). */
function features(): Record<string, string>[] {
  const src = readFileSync(new URL("../../../../replica/features.csv", import.meta.url), "utf8");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ""])));
}

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
  it("BSD-463: Ansichten aus Notion nur zusammen mit „Connect Notion directly“ (der ZIP-Import bringt eine Tabelle)", () => {
    for (const ai of [true, false]) {
      const notion = welcomeGuides(ai).flatMap((g) => g.lines.map((l) => l[1])).filter((t) => /notion/i.test(t));
      expect(notion.length).toBeGreaterThan(0);
      for (const t of notion) if (/\bviews?\b/i.test(t)) expect(t).toMatch(/connect notion directly/i);
    }
  });

  it("BSD-552: „Everything in Based“ ist die fünfte Seite", () => {
    expect(welcomeGuides(false, "beta").map((g) => g.title)).toEqual(["Basics", "Databases", "Keyboard", "Your data", "Everything in Based"]);
  });

  it("BSD-552: jede Zeile der Seite beruht nur auf Zeilen mit beta = beta, und jede solche Zeile ist abgedeckt", () => {
    const csv = features();
    const byName = new Map(csv.map((r) => [r.feature!, r]));
    const covered = EVERYTHING.flatMap((g) => g.lines.flatMap((l) => l.rows));
    for (const name of covered) {
      const r = byName.get(name);
      expect(r, `„${name}“ fehlt in features.csv`).toBeDefined();
      expect(r!.beta, name).toBe("beta");
      expect(r!.ts, name).toMatch(/^(yes|partial)/);
    }
    expect(new Set(covered).size, "eine CSV-Zeile steht zweimal").toBe(covered.length);
    const want = csv.filter((r) => r.beta === "beta" && /^(yes|partial)/.test(r.ts!)).map((r) => r.feature!);
    const missing = want.filter((n) => !covered.includes(n) && !EVERYTHING_INTERNAL.includes(n));
    expect(missing, "neue Beta-Funktion in features.csv: bitte in EVERYTHING aufnehmen").toEqual([]);
  });

  it("BSD-552: auf beta keine ausgeblendete Funktion und kein AI; am Ende „Not in this beta yet“", () => {
    const beta = everythingGuide("beta").lines.map((l) => l[1]);
    const text = beta.join("\n");
    expect(text).not.toMatch(/\bAI\b|agent|graph view|real-time|coding/i);
    expect(beta).toContain("Not in this beta yet");
    expect(beta.indexOf("Not in this beta yet")).toBeGreaterThan(beta.indexOf("The app"));
    expect(everythingGuide("dev").lines.map((l) => l[1])).not.toContain("Not in this beta yet");
    // Meeting notes nur, solange sie auf beta nicht ausgeblendet sind
    expect(beta.includes("Meeting notes")).toBe(!("meetings" in BETA_HIDDEN));
  });

  it("BSD-552: kurz genug für unter drei Minuten (≈ 200 Wörter pro Minute)", () => {
    const words = everythingGuide("beta").lines.map((l) => l[1]).join(" ").split(/\s+/).length;
    expect(words).toBeLessThan(600);
  });
});
