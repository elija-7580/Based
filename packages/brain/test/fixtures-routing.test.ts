// BSD-328 (Teil 1): Golden Fixtures für die Modellwahl. Die Fälle in fixtures/brain/routing.json stammen aus den
// Swift-Tests (ModelRouterTests, API-Hälfte); jeder Fall nennt seine Swift-Zeile. Bericht: „brain-routing: x/y grün“.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { modelTier, routeModel, ruleRoute, type AvailableModel, type ComputeLevel, type RouteTask } from "../src/index.js";

interface Case {
  name: string;
  source: string;
  input:
    | { kind: "ruleRoute"; task: RouteTask }
    | { kind: "modelTier"; model: string }
    | { kind: "decide"; task: RouteTask; compute: ComputeLevel; models: AvailableModel[]; defaultModel: string; forceLow?: boolean };
  output: { route?: string | null; tier?: number; model?: string | null; routeName?: string; compute?: ComputeLevel; reasonContains?: string };
}

const file = fileURLToPath(new URL("../../../fixtures/brain/routing.json", import.meta.url));
const doc = JSON.parse(readFileSync(file, "utf8")) as { module: string; cases: Case[] };
let passed = 0;

describe(`Golden Fixtures ${doc.module}`, () => {
  it("hat Fälle mit Swift-Quelle", () => {
    expect(doc.cases.length).toBeGreaterThan(0);
    for (const c of doc.cases) expect(c.source, c.name).toMatch(/\.swift:\d+/);
  });

  it.each(doc.cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
    const i = c.input;
    const o = c.output;
    if (i.kind === "ruleRoute") {
      expect(ruleRoute(i.task)?.id ?? null, c.source).toBe(o.route);
    } else if (i.kind === "modelTier") {
      expect(modelTier(i.model), c.source).toBe(o.tier);
    } else {
      const d = routeModel(i.task, i.compute, i.models, { defaultModel: i.defaultModel || undefined, forceLow: i.forceLow ?? false });
      expect(d.model ?? null, c.source).toBe(o.model);
      if (o.route !== undefined) expect(d.routeID, c.source).toBe(o.route);
      if (o.routeName !== undefined) expect(d.routeName, c.source).toBe(o.routeName);
      if (o.compute !== undefined) expect(d.level, c.source).toBe(o.compute);
      if (o.reasonContains !== undefined) expect(d.reason, c.source).toContain(o.reasonContains);
    }
    passed++;
  });

  afterAll(() => {
    console.log(`${doc.module}: ${passed}/${doc.cases.length} grün`);
  });
});
