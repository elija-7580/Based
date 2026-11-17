// BSD-450: Zeitmessungen in Playwright (@perf) wie `expectWithinBudget` in den Unit-Tests (BSD-322 Teil 4):
// lokal gelten die Schwellen hart, in der CI (Umgebungsvariable CI) wird eine Überschreitung nur als Warnung gemeldet
// (Annotation + ::warning) – dort teilen sich zwei Browser die Kerne. BASED_PERF_STRICT=1 macht sie auch dort hart.
// Funktionsprüfungen bleiben immer hart; nur echte Zeiten gehen hier durch.
import { expect, type TestInfo } from "@playwright/test";

const env = process.env;
export const perfSoft = !!env.CI && env.CI !== "0" && env.CI !== "false" && env.BASED_PERF_STRICT !== "1";

/** Zeit `value` (ms) unter `limit`: lokal `expect`, in der CI Warnung. */
export function expectFaster(info: TestInfo, label: string, value: number, limit: number): void {
  if (value < limit) return;
  const msg = `${label}: ${Math.round(value)} ms ≥ ${limit} ms`;
  if (perfSoft) {
    info.annotations.push({ type: "perf-warning", description: msg });
    console.warn(`::warning title=Zeitmessung::[${info.project.name}] ${msg}`);
  } else expect(value, msg).toBeLessThan(limit);
}

/**
 * Misst höchstens `tries`-mal, solange `over` (Schwelle überschritten) gilt, und gibt die beste Messung zurück – ein
 * Nachbarprozess kostet nur manchmal Zeit, eine echte Verschlechterung jedes Mal.
 */
export async function bestOf<T>(tries: number, measure: () => Promise<T>, over: (r: T) => boolean, better: (a: T, b: T) => boolean): Promise<T> {
  let best = await measure();
  for (let i = 1; i < tries && over(best); i++) {
    const next = await measure();
    if (better(next, best)) best = next;
  }
  return best;
}
