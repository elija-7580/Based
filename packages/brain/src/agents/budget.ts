// BSD-160 / BSD-51 (Swift `AgentBudget`): Budget pro Agent. Ausgaben = Summe der €-Kosten seiner Runs im laufenden
// Kalendermonat (API-Kosten aus den usage-Ereignissen). Abo-Anteile (Claude/ChatGPT über CLI) stehen nur als Feld am
// Run und werden nicht in € umgerechnet oder geschätzt. Ab 80 % Warnung, ab 100 % erschöpft: neue Unteragenten und
// geplante Läufe brauchen dann eine Bestätigung (Vorschlag-Karte) bzw. pausieren.
import type { AgentData, Rec, RunData } from "./records.js";
import { toMs } from "./records.js";

export type BudgetLevel = "ok" | "warning" | "exhausted";

/** USD → € mit dem Kurs des Agenten (Standard 0.92, in den Einstellungen änderbar). */
export const usdToEUR = (usd: number, agent?: Pick<AgentData, "eurPerUSD">) => usd * (agent?.eurPerUSD ?? 0.92);

const sameMonth = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

/** € dieses Agenten im Monat von `nowMs` (lokale Zeit). */
export function spentThisMonth(runs: readonly Rec<RunData>[], agentID: string, nowMs: number): number {
  const now = new Date(nowMs);
  let sum = 0;
  for (const r of runs) {
    if (r.data.agentID !== agentID) continue;
    if (!sameMonth(new Date(toMs(r.data.startedAt)), now)) continue;
    sum += r.data.costEUR || 0;
  }
  return Math.round(sum * 10_000) / 10_000;
}

/** € eines Projekts im Monat. */
export function projectSpentThisMonth(runs: readonly Rec<RunData>[], projectID: string, nowMs: number): number {
  const now = new Date(nowMs);
  return runs.filter((r) => r.data.projectID === projectID && sameMonth(new Date(toMs(r.data.startedAt)), now)).reduce((n, r) => n + (r.data.costEUR || 0), 0);
}

export function budgetLevel(spent: number, budget: number | undefined): BudgetLevel {
  if (budget === undefined || budget < 0) return "ok";
  if (spent >= budget) return "exhausted";
  if (spent >= 0.8 * budget) return "warning";
  return "ok";
}

/** Was vom Monatsbudget übrig ist (`undefined` = unbegrenzt). */
export function remaining(spent: number, budget: number | undefined): number | undefined {
  return budget === undefined ? undefined : Math.max(0, budget - spent);
}

/** Darf ein laufender Unteragent weitermachen? (Kosten des Laufs gegen seine Obergrenze und das Monatsbudget.) */
export function mayContinue(run: RunData, spentWithoutRun: number, agent: AgentData | undefined): { ok: true } | { ok: false; reason: string } {
  if (run.budgetEUR !== undefined && run.costEUR > run.budgetEUR) return { ok: false, reason: `run budget of ${run.budgetEUR.toFixed(2)} € reached` };
  const monthly = agent?.monthlyBudgetEUR;
  if (monthly !== undefined && spentWithoutRun + run.costEUR > monthly) return { ok: false, reason: `monthly budget of ${monthly.toFixed(2)} € reached` };
  return { ok: true };
}

/** „0.42 €“, „0.0031 €“. */
export function formatEUR(eur: number): string {
  if (eur === 0) return "0 €";
  if (eur < 0.01) return eur.toFixed(4) + " €";
  return eur.toFixed(2) + " €";
}
