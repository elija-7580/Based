// BSD-245: Plan-Modus. Schreibende Aufrufe werden in `executeTool` nicht ausgeführt, sondern gesammelt (PlanRecorder
// hängt sich als `policy.onPlanned` ein). „Plan ausführen“ = die Freigabe des Nutzers für alle Schritte zusammen:
// `runPlan` führt sie der Reihe nach aus – Regeln gelten weiter (deny blockiert), „ask“-Regeln gelten als mit dem
// Plan beantwortet. Jeder Schritt erscheint als Werkzeug-Karte im Transkript (toolUse + toolResult).
import type { JSONValue } from "@based/core";
import { executeTool, type ToolHost, type ToolPolicy, type ToolResult } from "./engine.js";
import type { ChatEvent } from "./events.js";
import type { ToolCall } from "./messages.js";

export interface PlannedStep {
  name: string;
  arguments: JSONValue;
}

export class PlanRecorder {
  readonly steps: PlannedStep[] = [];
  readonly record = (call: ToolCall) => {
    this.steps.push({ name: call.name, arguments: structuredClone(call.arguments) });
  };
}

/** Plan-Schritte aus einem gespeicherten Turn (die `toolUse`-Ereignisse, deren Ergebnis „nicht ausgeführt“ meldet). */
export function plannedSteps(events: readonly ChatEvent[], plannedText: string): PlannedStep[] {
  const uses = new Map<string, PlannedStep>();
  const out: PlannedStep[] = [];
  for (const e of events) {
    if (e.type === "toolUse") uses.set(e.id, { name: e.name, arguments: e.input });
    else if (e.type === "toolResult" && e.output === plannedText) {
      const s = uses.get(e.id);
      if (s) out.push(s);
    }
  }
  return out;
}

export interface PlanStepResult {
  step: PlannedStep;
  result: ToolResult;
}

export async function runPlan(
  host: ToolHost,
  steps: readonly PlannedStep[],
  policy: Pick<ToolPolicy, "rules">,
  signal: AbortSignal,
  emit: (e: ChatEvent) => void,
  newID: () => string = () => globalThis.crypto.randomUUID(),
): Promise<PlanStepResult[]> {
  const out: PlanStepResult[] = [];
  const approved: ToolPolicy = { mode: "free", rules: policy.rules, approve: async () => true };
  for (const step of steps) {
    if (signal.aborted) break;
    const id = newID();
    emit({ type: "toolUse", id, name: step.name, input: step.arguments });
    const result = await executeTool(host, { id, name: step.name, arguments: step.arguments }, approved, signal, () => {});
    emit({ type: "toolResult", id, output: result.text, isError: result.isError });
    out.push({ step, result });
  }
  return out;
}
