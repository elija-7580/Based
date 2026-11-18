// BSD-305 Teil 5: Die Anleitung „Your data“ erwähnt AI nur in Builds, die AI anbieten (auf beta fehlt der Schalter).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EVERYTHING_GROUPS, EVERYTHING_TITLE, NOT_IN_BETA, WELCOME_GUIDES, welcomeGuides } from "./welcomeGuides.js";

/** replica/features.csv als Zeilen (einfacher CSV-Leser mit Anführungszeichen). */
function features(): Map<string, Record<string, string>> {
  const raw = readFileSync(new URL("../../../../replica/features.csv", import.meta.url), "utf8");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quoted) {
      if (c === '"' && raw[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return new Map(body.map((r) => [r[0]!, Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ""]))]));
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
  it("BSD-552: „Everything in Based“ nennt nur Funktionen der Beta (features.csv: beta = beta, ts = yes|partial)", () => {
    const csv = features();
    const items = EVERYTHING_GROUPS.flatMap((g) => g.items);
    expect(items.length).toBeGreaterThan(20);
    for (const it of items) {
      const row = csv.get(it.feature);
      expect(row, it.feature).toBeDefined();
      expect(row!.beta, it.feature).toBe("beta");
      expect(row!.ts, it.feature).toMatch(/^(yes|partial)/);
    }
    // nichts, was auf beta ausgeblendet ist – außer in „Not in this beta yet“
    const said = items.map((i) => i.text).join("\n");
    expect(said).not.toMatch(/\bAI\b|agent|graph|coding|whiteboard|real-?time|share|sharing/i);
    expect(NOT_IN_BETA.join(" ")).toMatch(/AI/);
  });
  it("BSD-552: fünfte Anleitung, unter drei Minuten zu lesen", () => {
    expect(WELCOME_GUIDES.map((g) => g.title)).toEqual(["Basics", "Databases", "Keyboard", "Your data", EVERYTHING_TITLE]);
    const words = WELCOME_GUIDES.at(-1)!.lines.map((l) => l[1]).join(" ").split(/\s+/).length;
    expect(words).toBeLessThan(3 * 200); // ~200 Wörter pro Minute
  });
});
