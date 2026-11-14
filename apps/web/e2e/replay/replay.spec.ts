// BSD-319: Mitgelieferte Beispielbündel (bundles/*-<engine>.json, erzeugt mit record-sample.spec.ts) werden
// wiedergegeben und ergeben denselben Endzustand wie beim Melden – über Tasten (input) und über Schritte (steps).
// Block-Editor (ADR 0016): blocks-typing-basics-*; alter Editor (BlockNote, gepinnt): typing-basics-*.
// Vorlage für Tests aus echten Berichten: report.json aus ~/.config/based/reports/<id>/ (`based reports`) nach bundles/
// kopieren und hier eintragen; wiedergegeben wird in der Engine, die aufgezeichnet hat (engineOf).
import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";
import { legacyTest, ready, test } from "./fixture.js";
import { engineOf, replayReport } from "./replay.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./bundles/${name}.json`, import.meta.url), "utf8")) as unknown;
const BUNDLES = [
  { name: "blocks-typing-basics-chromium", t: test, bold: '"b":true' },
  { name: "blocks-typing-basics-webkit", t: test, bold: '"b":true' },
  { name: "typing-basics-chromium", t: legacyTest, bold: '"bold"' },
  { name: "typing-basics-webkit", t: legacyTest, bold: '"bold"' },
];

test.describe.configure({ timeout: 90_000 });

for (const { name, t, bold } of BUNDLES) {
  for (const mode of ["input", "steps"] as const) {
    t(`${name} wiedergeben (${mode}): gleicher Endzustand, keine Überdeckung`, async ({ page, browserName }) => {
      const bundle = load(name);
      t.skip(engineOf(bundle) !== browserName, "wird in der aufzeichnenden Engine wiedergegeben");
      await ready(page);
      const r = await replayReport(page, bundle, { mode });
      expect(r.plan.actions.length).toBeGreaterThan(mode === "input" ? 10 : 3);
      expect(r.expected).toBeDefined();
      // Das Bündel hält, was die Aufnahme wollte (⇧Home, ⌘B macht die erste Zeile fett) – nicht eine Zufallsreihenfolge.
      expect(JSON.stringify(r.expected)).toContain(bold);
      expect(r.doc).toEqual(r.expected);
      expect(r.issues).toEqual([]);
    });
  }
}
