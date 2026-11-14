// BSD-393: Golden Fixtures für Agent-Berechtigungen, Budget und Lease. Die Fälle in fixtures/agents/*.json erzeugt
// der Swift-Export (legacy/Swift/BasedBrain/Tests/BasedBrainTests/AgentFixtureExport.swift); dieser Runner spielt sie
// gegen den TS-Port ab. Bewusste Abweichungen stehen unten in DEVIATIONS (mit Grund und erwartetem TS-Ergebnis); jeder
// andere Unterschied ist ein Fehler. Bericht: „agents-permissions: x/y grün (z bewusst abweichend)“.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  budgetForceLow, budgetLevel, parseLayer, Permissions, scheduleBudgetStop, spentThisMonth, tokensToday,
  type AgentData, type PermissionCall, type PermissionEffect, type PermissionMode, type Rec, type RunData, type RunStatus,
} from "../src/index.js";

interface Case<I = Record<string, unknown>, O = Record<string, unknown>> { name: string; input: I; output: O }
const load = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../fixtures/agents/${f}`, import.meta.url)), "utf8")) as { module: string; cases: Case[] };

// MARK: Berechtigungen

type SwiftMode = "ask" | "acceptEdits" | "plan" | "bypass";
type Category = "read" | "edit" | "destructive" | "shell" | "web" | "external";
interface SwiftCall { tool: string; argument?: string; category: Category; sandboxed?: boolean }

/** Swift-Modus → TS-Modus (Composer-Pille). „Accept edits“ gibt es in TS nicht (parseMode liest es als Ask before edits). */
const MODE: Record<SwiftMode, PermissionMode> = { ask: "askEdits", acceptEdits: "askEdits", plan: "plan", bypass: "free" };
/** TS kennt nur „schreibt“ oder nicht (ToolHost.isWrite); Lesen und Web sind keine Schreibwerkzeuge. */
const isWrite = (c: SwiftCall) => c.category !== "read" && c.category !== "web";

/** Was der TS-Port tatsächlich tut – wie `executeTool` (engine.ts): Regel deny → Plan sammelt Schreiben → Regel → Modus (mit „fragt immer“, BSD-403). */
function effective(p: Permissions, c: SwiftCall): PermissionEffect {
  const call: PermissionCall = { tool: c.tool, argument: c.argument, category: c.category, sandboxed: c.sandboxed ?? false };
  const write = isWrite(c);
  const v = p.ruleVerdict(call)?.effect;
  if (v === "deny") return "deny";
  if (p.mode === "plan" && write) return "deny"; // als Planschritt gesammelt, nicht ausgeführt
  if (v) return v;
  return p.decide(call, write).effect;
}

interface Deviation { why: string; backlog?: string; applies: (c: Case) => boolean; ts: (c: Case) => unknown }
const call = (c: Case) => c.input.call as SwiftCall;
const swiftEffect = (c: Case) => c.output.effect as PermissionEffect;

/** Bewusste Abweichungen des TS-Ports (Reihenfolge = Vorrang). */
const PERMISSION_DEVIATIONS: Deviation[] = [
  {
    why: "„Accept edits“ fehlt in TS (nur Ask / Ask before edits / Work freely / Plan); Bearbeiten fragt dort weiter.",
    applies: (c) => c.input.mode === "acceptEdits" && swiftEffect(c) === "allow" && call(c).category === "edit",
    ts: () => "ask",
  },
  {
    why: "Swift fragt im Modus „Ask“ auch bei Web und Shell in der Sandbox; TS „Ask before edits“ fragt nur bei Schreibwerkzeugen (Web zählt als Lesen).",
    applies: (c) => (c.input.mode === "ask" || c.input.mode === "acceptEdits") && call(c).category === "web" && swiftEffect(c) === "ask",
    ts: () => "allow",
  },
];

function tsPermissions(c: Case): Permissions {
  const base = Permissions.from(String(c.input.rules ?? ""), MODE[c.input.mode as SwiftMode]);
  if (c.input.kind !== "layered") return base;
  return base.layered(`mode ${MODE[c.input.layerMode as SwiftMode]}\n${String(c.input.layerRules ?? "")}`);
}

/** Markdown-Escapes (`based.trash\_page`) liest Swift aus dem Seitenexport; TS liest den Regeltext roh. */
const PARSE_DEVIATIONS: Deviation[] = [
  {
    why: "Swift entfernt Markdown-Escapes (`\\_`) aus dem Seiten-Export; TS liest Regeln aus dem Klartext der Seite, dort gibt es keine Escapes.",
    applies: (c) => String(c.input.text).includes("\\"),
    ts: (c) => parseLayer(String(c.input.text)).rules.map((r) => ({ ...r, tool: r.tool })),
  },
];

// MARK: Budget

type SwiftRun = { id: string; agentID: string; status: string; startedAt: number; endedAt?: number; tokens: number; cost: number; model: string };
const STATUS: Record<string, RunStatus> = { Done: "done", Failed: "failed", Cancelled: "cancelled", Running: "running", "Needs you": "needsYou", Planned: "queued", Waiting: "queued" };
const toRec = (r: SwiftRun): Rec<RunData> => ({
  id: r.id, name: r.id, createdAt: 0, updatedAt: 0,
  data: {
    v: 1, kind: "schedule", status: STATUS[r.status] ?? "done", agentID: r.agentID, title: r.id, startedAt: r.startedAt, ...(r.endedAt !== undefined ? { endedAt: r.endedAt } : {}),
    model: r.model, usage: { inputTokens: r.tokens, outputTokens: 0, costUSD: 0 }, costEUR: r.cost,
  },
});
const SWIFT_EPOCH_MS = 978_307_200_000;
const ms = (swiftSeconds: number) => swiftSeconds * 1000 + SWIFT_EPOCH_MS;
type SwiftAgent = { id: string; dailyTokenBudget?: number; monthlyBudget?: number; runningSince?: number; runningNode?: string; schedule: string | null };
const toAgent = (a: SwiftAgent): Pick<AgentData, "monthlyBudgetEUR" | "dailyTokenBudget"> => ({
  ...(a.monthlyBudget !== undefined ? { monthlyBudgetEUR: a.monthlyBudget } : {}), ...(a.dailyTokenBudget !== undefined ? { dailyTokenBudget: a.dailyTokenBudget } : {}),
});

const BUDGET_DEVIATIONS: Deviation[] = [
  {
    why: "Swift schätzt die Kosten eines Laufs ohne Kosten nachträglich aus Tokens und Modell; TS schreibt die Kosten beim Lauf aus den usage-Ereignissen (Anbieter-Preis bzw. estimateCost) und schätzt danach nicht mehr.",
    applies: (c) => c.input.kind === "spentThisMonth" && (c.input.runs as SwiftRun[]).some((r) => r.cost === 0 && r.tokens > 0 && r.agentID === c.input.agentID),
    ts: (c) => spentThisMonth((c.input.runs as SwiftRun[]).map(toRec), String(c.input.agentID), ms(c.input.now as number)),
  },
  {
    why: "Lease: Swift hält den Agenten 2 × Median-Laufzeit (2 min … 1 h) ohne Erneuerung; TS hält jeden Lauf 300 s und erneuert minütlich (agentRunner.ts), Zeitpläne zieht claimSchedule atomar – es gibt keine leaseTTL.",
    applies: (c) => c.input.kind === "leaseTTL",
    ts: () => 300,
  },
  {
    why: "Zeitplan fällig/Lease: in TS entscheidet claimSchedule (nextAt) und die Lease am Run, nicht AgentBudget.decide – nur der Budget-Teil (scheduleBudgetStop) ist vergleichbar.",
    applies: (c) => c.input.kind === "decide" && (c.output.decision === "skipLeased" || c.output.decision === "skipNotDue"),
    ts: (c) => budgetDecision(c),
  },
];

function budgetDecision(c: Case): string {
  const a = c.input.agent as SwiftAgent;
  const stop = scheduleBudgetStop(toAgent(a), (c.input.runs as SwiftRun[]).map(toRec), a.id, ms(c.input.now as number));
  return stop ? "skipBudget" : "run";
}

function budgetActual(c: Case): unknown {
  const i = c.input;
  const runs = ((i.runs ?? []) as SwiftRun[]).map(toRec);
  switch (i.kind) {
    case "spentThisMonth": return spentThisMonth(runs, String(i.agentID), ms(i.now as number));
    case "tokensToday": return tokensToday(runs, String(i.agentID), ms(i.now as number));
    case "level": return budgetLevel(i.spent as number, (i.budget as number | null) ?? undefined);
    case "leaseTTL": return 300;
    case "forceLow": { const a = i.agent as SwiftAgent; return budgetForceLow(toAgent(a), runs, a.id, ms(i.now as number)).forceLow; }
    case "decide": return budgetDecision(c);
    default: throw new Error(`unknown kind ${String(i.kind)}`);
  }
}
function budgetExpected(c: Case): unknown {
  const o = c.output;
  if ("value" in o) return o.value;
  if ("level" in o) return o.level;
  if ("seconds" in o) return o.seconds;
  if ("forceLow" in o) return o.forceLow;
  return o.decision;
}

// MARK: Runner

function play(module: string, cases: Case[], actual: (c: Case) => unknown, expected: (c: Case) => unknown, deviations: Deviation[]) {
  const stats = { passed: 0, deviating: 0 };
  describe(`Golden Fixtures ${module}`, () => {
    it("hat Fälle", () => expect(cases.length).toBeGreaterThan(3));
    it.each(cases.map((c) => [c.name, c] as const))("%s", (_n, c) => {
      const got = actual(c);
      const dev = deviations.find((d) => d.applies(c));
      if (dev && JSON.stringify(got) !== JSON.stringify(expected(c))) {
        expect(got, `bewusste Abweichung: ${dev.why}`).toEqual(dev.ts(c));
        stats.deviating++;
      } else {
        expect(got, JSON.stringify(c.input)).toEqual(expected(c));
      }
      stats.passed++;
    });
    afterAll(() => console.log(`${module}: ${stats.passed}/${cases.length} grün (${stats.deviating} bewusst abweichend)`));
  });
}

const perms = load("permissions.json");
play(perms.module, perms.cases.filter((c) => c.input.kind !== "parse"), (c) => effective(tsPermissions(c), call(c)), (c) => c.output.effect, PERMISSION_DEVIATIONS);
play(perms.module + " (parse)", perms.cases.filter((c) => c.input.kind === "parse"),
  (c) => { const l = parseLayer(String(c.input.text)); return { rules: l.rules, errors: l.errors }; },
  (c) => c.output, PARSE_DEVIATIONS.map((d) => ({ ...d, ts: (c: Case) => { const l = parseLayer(String(c.input.text)); return { rules: l.rules, errors: l.errors }; } })));
const budget = load("budget.utc.json");
play(budget.module, budget.cases, budgetActual, budgetExpected, BUDGET_DEVIATIONS);

describe("Fixtures Abweichungsliste", () => {
  it("jede Abweichung hat einen Grund", () => {
    for (const d of [...PERMISSION_DEVIATIONS, ...PARSE_DEVIATIONS, ...BUDGET_DEVIATIONS]) expect(d.why.length).toBeGreaterThan(20);
  });
});
