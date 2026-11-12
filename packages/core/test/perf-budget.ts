// BSD-322 Teil 4: Zeitmessungen in Unit-Tests. Lokal gelten die Schwellen unverändert (gemessen als CPU-Zeit, siehe
// `cpuTime`), aber eine Messung zählt erst, wenn sie auch beim zweiten und dritten Versuch darüber liegt (eine echte
// Verschlechterung ist jedes Mal langsam, ein Nachbarprozess unter `pnpm -r test` nur manchmal). In der CI (Umgebungsvariable CI, auf GitHub immer gesetzt)
// wird eine Überschreitung nur als Warnung gemeldet und blockiert nicht; BASED_PERF_STRICT=1 macht sie dort hart.
import { expect } from "vitest";

const proc = (globalThis as { process?: { env?: Record<string, string | undefined>; cpuUsage?: (prev?: { user: number; system: number }) => { user: number; system: number } } }).process;
const env = proc?.env ?? {};
export const perfSoft = !!env.CI && env.CI !== "0" && env.CI !== "false" && env.BASED_PERF_STRICT !== "1";

/**
 * Dauer von `f` in ms als CPU-Zeit dieses Prozesses (Node), sonst Wanduhr. CPU-Zeit wächst nicht, wenn andere
 * Prozesse den Rechner belegen (unter `pnpm -r test` laufen alle Pakete parallel; die Wanduhr maß dort bis zum
 * Doppelten), eine echte Verschlechterung im Code zeigt sie aber genauso.
 */
export function cpuTime(f: () => void): number {
  if (!proc?.cpuUsage) {
    const t = performance.now();
    f();
    return performance.now() - t;
  }
  const start = proc.cpuUsage();
  f();
  const d = proc.cpuUsage(start);
  return (d.user + d.system) / 1000;
}

/**
 * Führt `run` aus (ein vollständiger Durchgang, der seine Zeiten in ms liefert) und wiederholt ihn höchstens
 * `tries`-mal, solange eine Zeit über ihrer Schwelle liegt. Je Messung zählt die beste. Danach: lokal `expect`,
 * in der CI eine Warnung.
 */
export function expectWithinBudget<K extends string>(label: string, limits: Record<K, number>, run: () => Record<K, number>, tries = 3): Record<K, number> {
  const keys = Object.keys(limits) as K[];
  const best = run();
  for (let i = 1; i < tries && keys.some((k) => best[k] >= limits[k]); i++) {
    const next = run();
    for (const k of keys) best[k] = Math.min(best[k], next[k]);
  }
  for (const k of keys) {
    if (best[k] < limits[k]) continue;
    const msg = `${label} · ${k}: ${best[k].toFixed(0)} ms ≥ ${limits[k]} ms (bester von ${tries} Versuchen)`;
    if (perfSoft) console.warn(`::warning title=Zeitmessung::${msg}`);
    else expect(best[k], msg).toBeLessThan(limits[k]);
  }
  return best;
}
