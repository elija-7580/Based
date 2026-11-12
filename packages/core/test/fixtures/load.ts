// BSD-149: Golden Fixtures aus Swift laden (fixtures/<modul>/*.json, erzeugt mit `swift run based-fixtures`).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FIXTURES_DIR = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));

export interface FixtureCase { name: string; input: unknown; output: unknown }
export interface FixtureFile { module: string; file: string; cases: FixtureCase[]; meta: Record<string, unknown> }

/** Alle JSON-Fixture-Dateien des Kerns (records/ hat eigenes Format und eigenen Test; brain/ spielt packages/brain ab, BSD-328). */
export function loadFixtureFiles(): FixtureFile[] {
  const out: FixtureFile[] = [];
  for (const dir of readdirSync(FIXTURES_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === "records" || dir.name === "brain") continue;
    for (const file of readdirSync(FIXTURES_DIR + dir.name).filter((f) => f.endsWith(".json")).sort()) {
      const json = JSON.parse(readFileSync(`${FIXTURES_DIR}${dir.name}/${file}`, "utf8")) as Record<string, unknown>;
      const { module, cases, ...meta } = json as { module: string; cases: FixtureCase[] };
      out.push({ module, file: `${dir.name}/${file}`, cases, meta });
    }
  }
  return out;
}
