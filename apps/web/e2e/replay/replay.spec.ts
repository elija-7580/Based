// BSD-319: Mitgelieferte Beispielbündel (bundles/typing-basics-<engine>.json, erzeugt mit record-sample.spec.ts)
// werden wiedergegeben und ergeben denselben Endzustand wie beim Melden – über Tasten (input) und über Schritte
// (steps). Vorlage für Tests aus echten Berichten: report.json aus ~/.config/based/reports/<id>/ (`based reports`)
// nach bundles/ kopieren und hier eintragen; wiedergegeben wird in der Engine, die aufgezeichnet hat (engineOf).
import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { legacyTest as test, ready } from "./fixture.js";
import { engineOf, replayReport } from "./replay.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./bundles/${name}.json`, import.meta.url), "utf8")) as unknown;
const BUNDLES = ["typing-basics-chromium", "typing-basics-webkit"];

test.describe.configure({ timeout: 90_000 });

for (const name of BUNDLES) {
  for (const mode of ["input", "steps"] as const) {
    test(`${name} wiedergeben (${mode}): gleicher Endzustand, keine Überdeckung`, async ({ page, browserName }) => {
      const bundle = load(name);
      test.skip(engineOf(bundle) !== browserName, "wird in der aufzeichnenden Engine wiedergegeben");
      await ready(page);
      const r = await replayReport(page, bundle, { mode });
      expect(r.plan.actions.length).toBeGreaterThan(mode === "input" ? 10 : 3);
      expect(r.expected).toBeDefined();
      // Das Bündel hält, was die Aufnahme wollte (⇧Home, ⌘B macht die erste Zeile fett) – nicht eine Zufallsreihenfolge.
      expect(JSON.stringify(r.expected)).toContain('"bold"');
      expect(r.doc).toEqual(r.expected);
      expect(r.issues).toEqual([]);
    });
  }
}
