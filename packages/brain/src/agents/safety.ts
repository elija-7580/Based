// BSD-196 / ADR 0013 §3: Sicherheitsstufen. Umkehrbar und billig → sofort mit Undo; kostet Geld oder wirkt nach
// außen → Vorschlag; unsicher → Rückfrage. Die Schwellen hängen an den Berechtigungsmodi (wie im Composer:
// Ask / Ask before edits / Work freely), an Regeln (BSD-160, permissions.ts) und am Budget des Agenten.
import type { PermissionMode } from "../engine.js";
import type { PlannedAction, ValidPlan } from "./plan.js";
import type { Decision, TaskData } from "./task.js";

/** Art einer Aktion für Modus und Regeln. */
export type ActionCategory = "read" | "create" | "edit" | "cost";

export function categoryOf(a: PlannedAction): ActionCategory {
  switch (a.type) {
    case "answer": case "ask": return "read";
    case "create_page": case "create_task": case "schedule": return "create";
    // schreibt in eine bestehende Projektseite
    case "file_to_project": return "edit";
    case "spawn_agent": return "cost";
  }
}

/** Regel-Urteil für eine Aktion (`based.<aktion>`), `undefined` = keine Regel greift. */
export type RuleDecider = (a: PlannedAction) => { effect: "allow" | "ask" | "deny"; reason: string } | undefined;

export interface SafetyContext {
  mode: PermissionMode;
  rules?: RuleDecider | undefined;
  /** Unter dieser Sicherheit fragt die Karte nach (Standard 0.5). */
  minConfidence?: number;
  /** Was ein Unteragent pro Auftrag ohne Bestätigung kosten darf (€); `undefined` = kein Limit. */
  perTaskEUR?: number | undefined;
  /** Was vom Monatsbudget des Agenten übrig ist (€); `undefined` = unbegrenzt. */
  remainingEUR?: number | undefined;
  /** Schätzung ohne Angabe des Modells (€). */
  defaultEstimateEUR?: number;
}

export interface SafetyResult {
  decisions: Record<string, Decision>;
  next: "question" | "proposal" | "executing";
  question?: TaskData["question"];
  proposal?: string[];
}

const modeEffect = (mode: PermissionMode, c: ActionCategory): Decision => {
  if (c === "read") return "auto";
  if (mode === "free") return "auto";
  // Ask und Plan (BSD-245): jede Änderung wird als Plan vorgeschlagen und erst nach Freigabe ausgeführt.
  if (mode === "ask" || mode === "plan") return "propose";
  // Ask before edits: Neues anlegen ist umkehrbar (Undo), Bestehendes ändern fragt; Kosten entscheidet das Budget.
  return c === "edit" ? "propose" : "auto";
};

/** Entscheidung je Aktion und der nächste Zustand des Auftrags. */
export function assess(plan: ValidPlan, ctx: SafetyContext): SafetyResult {
  const decisions: Record<string, Decision> = {};
  const reasons: string[] = [];
  const minConf = ctx.minConfidence ?? 0.5;
  let question: TaskData["question"] | undefined;
  for (const a of plan.actions) {
    if (a.type === "ask") {
      decisions[a.id] = "ask";
      question ??= { actionID: a.id, text: a.question, options: a.options };
      continue;
    }
    let d = modeEffect(ctx.mode, categoryOf(a));
    if (d === "propose") reasons.push(`${ctx.mode === "ask" ? "Ask mode" : ctx.mode === "plan" ? "Plan mode" : "Ask before edits"}: ${a.type.replace(/_/g, " ")}`);
    if (a.type === "spawn_agent") {
      const est = a.estimateEUR ?? ctx.defaultEstimateEUR ?? 0;
      if (ctx.perTaskEUR !== undefined && est > ctx.perTaskEUR) {
        d = "propose";
        reasons.push(`≈ ${est.toFixed(2)} € is above the ${ctx.perTaskEUR.toFixed(2)} € limit per task`);
      }
      if (ctx.remainingEUR !== undefined && est > ctx.remainingEUR) {
        d = "propose";
        reasons.push(`only ${Math.max(0, ctx.remainingEUR).toFixed(2)} € left of this month's budget`);
      }
    }
    const rule = ctx.rules?.(a);
    if (rule) {
      if (rule.effect === "deny") {
        d = "deny";
        reasons.push(`blocked by ${rule.reason}`);
      } else if (rule.effect === "ask" && d !== "deny") {
        d = "propose";
        reasons.push(rule.reason);
      } else if (rule.effect === "allow" && d === "propose" && !(a.type === "spawn_agent" && reasons.some((r) => r.includes("€")))) {
        // Erlaubt-Regel hebt die Modus-Frage auf, nie die Budgetgrenze
        d = "auto";
        reasons.splice(reasons.findIndex((r) => r.startsWith("Ask")), 1);
      }
    }
    if (d !== "deny" && a.confidence < minConf && !question) {
      question = { actionID: a.id, text: `Not sure${a.reason ? ` (${a.reason})` : ""}. ${capitalize(describeAction(a))}?`, options: ["Yes, do it", "File as note"] };
    }
    decisions[a.id] = d;
  }
  if (question) return { decisions, next: "question", question };
  const runnable = plan.actions.filter((a) => decisions[a.id] !== "deny");
  if (runnable.length === 0) return { decisions, next: "proposal", proposal: reasons.length ? reasons : ["Every action is blocked by a rule"] };
  if (Object.values(decisions).some((d) => d === "propose" || d === "deny")) return { decisions, next: "proposal", proposal: [...new Set(reasons)] };
  return { decisions, next: "executing" };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function describeAction(a: PlannedAction): string {
  switch (a.type) {
    case "answer": return "answer";
    case "create_page": return `create the page “${a.title}”`;
    case "create_task": return `add the task “${a.title}”`;
    case "file_to_project": return `file this into ${a.projectName ?? "the project"}`;
    case "spawn_agent": return `start an agent for “${a.title}”`;
    case "schedule": return `schedule “${a.title}” (${a.when})`;
    case "ask": return a.question;
  }
}
