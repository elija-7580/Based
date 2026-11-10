// BSD-196 / ADR 0013 Teil 2: der Plan als Daten. Ein günstiges Modell wählt nur Bausteine aus diesem festen Katalog
// (answer, create_page, create_task, file_to_project, spawn_agent, schedule, ask) – je mit Begründung (eine Zeile) und
// Sicherheit (0…1). Ein deterministischer Ausführer setzt den Plan um (executor.ts). Ungültige Ausgabe wird nie
// verworfen: einmal neu versuchen, dann als Notiz ablegen (runner.ts).
import { z } from "zod";

const base = {
  /** Idempotenz-ID der Aktion innerhalb des Auftrags („a1“ …); fehlt sie, vergibt `parsePlan` eine. */
  id: z.string().min(1).max(40).optional(),
  /** Eine Zeile, warum. */
  reason: z.string().max(300).default(""),
  /** Wie sicher das Modell ist (0…1). */
  confidence: z.number().min(0).max(1).default(0.8),
};

const text = (max: number) => z.string().trim().min(1).max(max);

export const planAction = z.discriminatedUnion("type", [
  /** Antwort direkt auf der Karte (reine Frage). */
  z.object({ type: z.literal("answer"), ...base, text: text(8000) }),
  /** Neue Seite (Markdown), optional unter einer Seite oder in einem Projekt. */
  z.object({ type: z.literal("create_page"), ...base, title: text(200), markdown: z.string().max(20_000).optional(), parentID: z.string().optional(), projectID: z.string().optional() }),
  /** Aufgabe (To-do), optional mit Termin (YYYY-MM-DD) und Projekt. */
  z.object({ type: z.literal("create_task"), ...base, title: text(300), due: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "due must be YYYY-MM-DD").optional(), projectID: z.string().optional() }),
  /** Einsortieren: Update (Markdown) auf die Projektseite; ein neuer Name legt das Projekt an. */
  z.object({ type: z.literal("file_to_project"), ...base, projectID: z.string().optional(), projectName: z.string().trim().min(1).max(120).optional(), note: text(8000) })
    .refine((a) => a.projectID !== undefined || a.projectName !== undefined, { message: "file_to_project needs projectID or projectName" }),
  /** Unteragent mit Auftrag, Modell und geschätzten Kosten (€). */
  z.object({ type: z.literal("spawn_agent"), ...base, title: text(200), instructions: text(8000), model: z.string().optional(), estimateEUR: z.number().min(0).max(1000).optional(), projectID: z.string().optional() }),
  /** Termin/Erinnerung/wiederkehrender Lauf: `when` wie in schedule.ts („daily 07:30“, „2026-11-12 09:00“ …). */
  z.object({ type: z.literal("schedule"), ...base, title: text(200), when: text(100), prompt: z.string().max(4000).optional(), projectID: z.string().optional() }),
  /** Rückfrage an der Karte mit 2–3 Knöpfen. */
  z.object({ type: z.literal("ask"), ...base, question: text(300), options: z.array(text(60)).min(2).max(3) }),
]);

export const plan = z.object({
  actions: z.array(planAction).min(1).max(8),
  /** Ein Satz für die Karte („Creates a page in Publit“). */
  summary: z.string().max(300).optional(),
});

export type PlanAction = z.infer<typeof planAction>;
export type ActionType = PlanAction["type"];
export type Plan = z.infer<typeof plan>;
/** Aktion mit sicherer ID (nach `parsePlan`). */
export type PlannedAction = PlanAction & { id: string };
export interface ValidPlan extends Plan {
  actions: PlannedAction[];
}

export const ACTION_TYPES: readonly ActionType[] = ["answer", "create_page", "create_task", "file_to_project", "spawn_agent", "schedule", "ask"];

/** Kurzbeschreibung für das System-Prompt des Planers (eine Zeile je Baustein). */
export const ACTION_CATALOG = `- answer {text}: answer a pure question directly on the card.
- create_page {title, markdown?, parentID?, projectID?}: a new page.
- create_task {title, due? (YYYY-MM-DD), projectID?}: a to-do, optionally with a due date.
- file_to_project {projectID | projectName, note}: file the input into a project as an update (a new projectName creates the project).
- spawn_agent {title, instructions, model?, estimateEUR?, projectID?}: start a sub-agent for research or longer work.
- schedule {title, when, prompt?}: a reminder or recurring run. when: "YYYY-MM-DD HH:MM", "daily HH:MM", "weekdays HH:MM", "weekly mon HH:MM", "every 2h".
- ask {question, options (2-3 short labels)}: ask back when unsure (which project? which date?).`;

export type PlanParse = { ok: true; plan: ValidPlan } | { ok: false; error: string };

/** Erstes JSON-Objekt aus Modelltext: Codeblock ```json …``` oder vom ersten „{“ bis zur passenden „}“. */
export function extractJSON(raw: string): string | undefined {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const s = fence ? fence[1]! : raw;
  const start = s.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Zod-Fehler kurz und fürs Modell lesbar („actions.0.title: Required“). */
function describe(error: z.ZodError): string {
  return error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "plan"}: ${i.message}`).join("; ");
}

/**
 * Modellausgabe → gültiger Plan. Prüft das Schema, vergibt fehlende/doppelte IDs (a1, a2 …) und kennt optional die
 * gültigen Projekt-IDs (eine erfundene ID ist ein Fehler, damit der Ausführer nie ins Leere schreibt).
 */
export function parsePlan(raw: string, ctx: { projectIDs?: ReadonlySet<string> } = {}): PlanParse {
  const json = extractJSON(raw);
  if (!json) return { ok: false, error: "no JSON object found" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: "invalid JSON: " + (e instanceof Error ? e.message : String(e)) };
  }
  const r = plan.safeParse(value);
  if (!r.success) return { ok: false, error: describe(r.error) };
  const seen = new Set<string>();
  const actions = r.data.actions.map((a, i) => {
    let id = a.id && !seen.has(a.id) ? a.id : `a${i + 1}`;
    while (seen.has(id)) id += "_";
    seen.add(id);
    return { ...a, id } as PlannedAction;
  });
  if (ctx.projectIDs) {
    for (const a of actions) {
      const pid = "projectID" in a ? a.projectID : undefined;
      if (pid !== undefined && !ctx.projectIDs.has(pid)) return { ok: false, error: `unknown projectID ${pid} (use one from the list or projectName)` };
    }
  }
  const out: ValidPlan = { actions };
  if (r.data.summary) out.summary = r.data.summary;
  return { ok: true, plan: out };
}

/** Eine Zeile je Aktion für Karte und Protokoll. */
export function actionLabel(a: PlanAction, projectName?: (id: string) => string | undefined): string {
  const proj = (id?: string) => (id ? projectName?.(id) ?? "project" : undefined);
  switch (a.type) {
    case "answer": return "Answer";
    case "create_page": return `Page “${a.title}”` + (a.projectID ? ` in ${proj(a.projectID)}` : "");
    case "create_task": return `Task “${a.title}”` + (a.due ? ` · due ${a.due.slice(0, 10)}` : "");
    case "file_to_project": return `Update in ${a.projectName ?? proj(a.projectID)}`;
    case "spawn_agent": return `Start agent “${a.title}”` + (a.model ? ` · ${a.model}` : "") + (a.estimateEUR !== undefined ? ` · up to ${a.estimateEUR.toFixed(2)} €` : "");
    case "schedule": return `Schedule “${a.title}” · ${a.when}`;
    case "ask": return a.question;
  }
}
