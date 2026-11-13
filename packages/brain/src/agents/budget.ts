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

/** BSD-392 (Swift `AgentBudget.tokensToday`): Tokens (Ein- + Ausgabe) der Läufe des Agenten, die am Tag von `nowMs` (lokal) begannen. */
export function tokensToday(runs: readonly Rec<RunData>[], agentID: string, nowMs: number): number {
  const now = new Date(nowMs);
  let sum = 0;
  for (const r of runs) {
    if (r.data.agentID !== agentID) continue;
    const d = new Date(toMs(r.data.startedAt));
    if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate()) continue;
    sum += (r.data.usage?.inputTokens || 0) + (r.data.usage?.outputTokens || 0);
  }
  return sum;
}

/**
 * BSD-392 (Swift `AgentBudget.forceLow`, BSD-126): ab 80 % des Monatsbudgets ODER des Tages-Token-Budgets läuft der
 * Agent auf Low. `reason` steht im Routing-Text bzw. am Lauf.
 */
export function budgetForceLow(agent: Pick<AgentData, "monthlyBudgetEUR" | "dailyTokenBudget"> | undefined, runs: readonly Rec<RunData>[], agentID: string, nowMs: number): { forceLow: boolean; reason?: string } {
  const daily = agent?.dailyTokenBudget;
  if (daily !== undefined && daily > 0) {
    const used = tokensToday(runs, agentID, nowMs);
    if (used >= 0.8 * daily) return { forceLow: true, reason: `daily token budget at ${Math.round((used / daily) * 100)} %` };
  }
  const budget = agent?.monthlyBudgetEUR;
  const spent = spentThisMonth(runs, agentID, nowMs);
  if (budgetLevel(spent, budget) !== "ok") return { forceLow: true, reason: `monthly budget at ${Math.round((spent / Math.max(budget!, 1e-9)) * 100)} %` };
  return { forceLow: false };
}

/**
 * BSD-392 (Swift `AgentBudget.decide` → skipBudget): Grund, warum ein geplanter Lauf nicht startet – Tages-Token-Budget
 * erreicht oder Monatsbudget aufgebraucht; `undefined` = darf laufen (ab 80 % dann auf Low).
 */
export function scheduleBudgetStop(agent: Pick<AgentData, "monthlyBudgetEUR" | "dailyTokenBudget"> | undefined, runs: readonly Rec<RunData>[], agentID: string, nowMs: number): string | undefined {
  const daily = agent?.dailyTokenBudget;
  if (daily !== undefined && daily >= 0) {
    const used = tokensToday(runs, agentID, nowMs);
    if (used >= daily) return `daily token budget used up (${used} of ${daily} tokens)`;
  }
  const budget = agent?.monthlyBudgetEUR;
  const spent = spentThisMonth(runs, agentID, nowMs);
  if (budget !== undefined && spent >= budget) return `monthly budget used up (${spent.toFixed(2)} € of ${budget.toFixed(2)} €)`;
  return undefined;
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
