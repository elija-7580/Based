// BSD-149: Welche Module im TS-Kern schon portiert sind. Ein Port bekommt die Datei-Metadaten
// (z. B. Records, `now`) und einen Fall und liefert die Ausgabe im Fixture-Format.
// Phase 1 (BSD-151) trägt hier pro Modul seine Implementierung ein; nicht eingetragene Module werden
// übersprungen und im Bericht als „nicht portiert“ geführt.
import type { FixtureCase } from "./load.js";

export type Port = (input: FixtureCase["input"], meta: Record<string, unknown>) => unknown;

export const PORTS: Record<string, Port | undefined> = {
  // hlc: …, sortkeys: …, formulas: …, queries: …, values: …, merge: …
};
