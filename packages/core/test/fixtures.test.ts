// BSD-149: Runner für die Golden Fixtures. Pro Modul: alle Fälle gegen den TS-Port abspielen.
// Bericht am Ende: „<modul>: x/y grün“ bzw. „nicht portiert“.
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { parseRecord } from "../src/index.js";
import { FIXTURES_DIR, loadFixtureFiles } from "./fixtures/load.js";
import { PORTS } from "./fixtures/ports.js";

const files = loadFixtureFiles();
const report = new Map<string, { passed: number; total: number; ported: boolean }>();
const tally = (module: string, total: number, ported: boolean) => {
  const r = report.get(module) ?? { passed: 0, total: 0, ported };
  r.total += total;
  report.set(module, r);
  return r;
};

// records: von records.test.ts abgedeckt (BSD-148), hier nur für den Bericht gezählt.
const corpus = readFileSync(FIXTURES_DIR + "records/corpus.jsonl", "utf8").split("\n").filter(Boolean);
const recordTally = tally("records", corpus.length, true);
recordTally.passed = corpus.filter((l) => {
  try {
    return JSON.stringify(parseRecord(JSON.parse(l))) !== undefined;
  } catch {
    return false;
  }
}).length;

describe("Fixture-Dateien sind gültig", () => {
  it("es gibt Fixtures für die Kernmodule", () => {
    const modules = new Set(files.map((f) => f.module));
    for (const m of ["hlc", "sortkeys", "formulas", "merge", "queries", "values"]) expect(modules, m).toContain(m);
  });
  it.each(files.map((f) => [f.file, f] as const))("%s hat Fälle mit name/input/output", (_n, f) => {
    expect(f.cases.length).toBeGreaterThan(0);
    for (const c of f.cases) {
      expect(typeof c.name).toBe("string");
      expect(c).toHaveProperty("input");
      expect(c).toHaveProperty("output");
    }
  });
  it.each(files.filter((f) => Array.isArray(f.meta.records)).map((f) => [f.file, f] as const))(
    "%s: eingebettete Records passen zum TS-Schema",
    (_n, f) => {
      for (const r of f.meta.records as unknown[]) expect(() => parseRecord(r)).not.toThrow();
    },
  );
  it("merge: Records in den Schritten passen zum TS-Schema", () => {
    for (const f of files.filter((x) => x.module === "merge"))
      for (const c of f.cases) for (const step of c.input as { records: unknown[] }[]) for (const r of step.records) parseRecord(r);
  });
});

for (const f of files) {
  const port = PORTS[f.module];
  const t = tally(f.module, f.cases.length, Boolean(port));
  if (!port) {
    describe.skip(`${f.file} (nicht portiert)`, () => it("–", () => {}));
    continue;
  }
  describe(f.file, () => {
    it.each(f.cases.map((c, i) => [i, c.name, c] as const))("#%i %s", (_i, _name, c) => {
      expect(port(c.input, f.meta)).toEqual(c.output);
      t.passed += 1;
    });
  });
}

afterAll(() => {
  const lines = [...report.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, r]) => `  ${m.padEnd(10)} ${r.ported ? `${r.passed}/${r.total} grün` : `nicht portiert (${r.total} Fälle)`}`);
  console.log("Golden Fixtures (fixtures/, swift run based-fixtures):\n" + lines.join("\n"));
});
