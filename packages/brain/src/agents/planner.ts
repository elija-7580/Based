// BSD-196 / ADR 0013 §2: Verstehen. Ein günstiges Modell bekommt Eingabe + kompakten Kontext (aktive Projekte,
// Antworten auf Rückfragen, persönliche Korrektur-Beispiele) und antwortet mit einem Plan als JSON. Der Planer läuft
// über jede vorhandene Engine (ChatEvent-Strom, ADR 0005) und prüft das Ergebnis gegen das Schema. Ungültig →
// `{ ok: false }`; Retry und Fallback entscheidet der Runner, damit der Zähler im Auftrag steht (Neustart-fest).
//
// `RulesPlannerEngine` ist die Scripted-Variante für Tests, Golden-Set und E2E: deterministische Regeln (DE/EN) statt
// eines Modells, gleiche Schnittstelle, gleicher Weg durch Schema-Prüfung und Ausführer.
import { runTurn, type ChatEngine, type ChatRequest } from "../engine.js";
import type { ChatEvent } from "../events.js";
import { ACTION_CATALOG, parsePlan, type PlanAction, type PlanParse } from "./plan.js";
import { parseSchedule } from "./schedule.js";

export interface PlannerProject {
  id: string;
  name: string;
  goal?: string | undefined;
}

/** Eine Korrektur des Nutzers als Few-Shot-Beispiel (ADR 0013 §5). */
export interface PlannerExample {
  input: string;
  /** Was richtig gewesen wäre (kurz, z. B. „file_to_project Based“). */
  correction: string;
}

export interface PlannerContext {
  projects: readonly PlannerProject[];
  /** Antworten auf frühere Rückfragen dieses Auftrags. */
  answers?: readonly string[] | undefined;
  examples?: readonly PlannerExample[] | undefined;
  /** Fehler des letzten Versuchs (für den Retry). */
  previousError?: string | undefined;
  /** Heute (YYYY-MM-DD). */
  today: string;
}

export const PLANNER_SYSTEM = `You are the planner of Based's main agent. Turn the user's input into a plan made ONLY of these actions:
${ACTION_CATALOG}

Reply with one JSON object and nothing else:
{"summary": "<one short sentence>", "actions": [{"type": "...", "reason": "<one line>", "confidence": 0.0-1.0, ...fields}]}

Rules:
- Use projectID only from the PROJECTS list; to file into a project that is not listed, use projectName.
- Pure questions get one "answer" action with the answer text.
- When two targets fit equally well or something essential is missing, use "ask" with 2-3 short options.
- Keep the input's language for titles and notes.`;

export interface PlanAttempt {
  parse: PlanParse;
  /** Rohtext des Modells (für das Protokoll gekürzt). */
  raw: string;
  /** Verbrauch der Planung (aus usage-Ereignissen). */
  usage: { inputTokens: number; outputTokens: number; costUSD: number };
  model?: string | undefined;
}

/** Die Eingabe als Prompt (strukturiert, damit auch die Regel-Engine sie lesen kann). */
export function plannerPrompt(input: string, ctx: PlannerContext): string {
  const parts = [`TODAY: ${ctx.today}`, `PROJECTS: ${JSON.stringify(ctx.projects.map((p) => ({ id: p.id, name: p.name, ...(p.goal ? { goal: p.goal } : {}) })))}`];
  if (ctx.examples?.length) parts.push("CORRECTIONS (the user corrected earlier plans like this):\n" + ctx.examples.slice(0, 8).map((e) => `- "${e.input}" → ${e.correction}`).join("\n"));
  if (ctx.answers?.length) parts.push(`ANSWERS TO YOUR QUESTIONS: ${JSON.stringify(ctx.answers)}`);
  if (ctx.previousError) parts.push(`YOUR LAST REPLY WAS INVALID: ${ctx.previousError}. Reply with valid JSON only.`);
  parts.push(`INPUT:\n${input}`);
  return parts.join("\n\n");
}

/** Ein Planversuch über `engine`. Wirft nur bei Abbruch oder Engine-Fehler (Netz, Schlüssel). */
export async function planOnce(engine: ChatEngine, input: string, ctx: PlannerContext, signal: AbortSignal): Promise<PlanAttempt> {
  const request: ChatRequest = { prompt: plannerPrompt(input, ctx), system: PLANNER_SYSTEM };
  let text = "", model: string | undefined;
  const usage = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
  for await (const e of runTurn(engine, request, signal)) {
    if (e.type === "text") text = text ? text + "\n" + e.text : e.text;
    else if (e.type === "usage") {
      usage.inputTokens += e.inputTokens;
      usage.outputTokens += e.outputTokens;
      usage.costUSD += e.costUSD ?? 0;
      model ??= e.model;
    } else if (e.type === "started") model ??= e.model;
    else if (e.type === "failed") {
      if (e.stopped) throw new DOMException("Stopped", "AbortError");
      throw new Error(e.message);
    }
  }
  let parse = parsePlan(text, { projectIDs: new Set(ctx.projects.map((p) => p.id)) });
  if (parse.ok) {
    const bad = parse.plan.actions.find((a) => a.type === "schedule" && !parseSchedule(a.when));
    if (bad && bad.type === "schedule") parse = { ok: false, error: `can't read when "${bad.when}" (use "YYYY-MM-DD HH:MM", "daily HH:MM", "weekly mon HH:MM" or "every 2h")` };
  }
  return { parse, raw: text.slice(0, 2000), usage, model };
}

// MARK: Regel-Engine (Scripted)

const has = (s: string, words: readonly string[]) => words.some((w) => new RegExp(`(^|[^\\p{L}])${w}`, "iu").test(s));

const QUESTION_START = ["what", "who", "how", "why", "when", "where", "which", "is", "are", "can", "does", "do", "was", "wer", "wie", "warum", "wann", "wo", "welche", "welcher", "ist", "sind", "kann", "gibt"];
const SCHEDULE = ["remind", "erinner", "every day", "every week", "every morning", "daily", "weekly", "täglich", "jeden tag", "jeden morgen", "jede woche", "wöchentlich", "each morning", "each day"];
const RESEARCH = ["research", "recherchier", "find out", "investigate", "compare", "vergleich", "analy", "look into", "untersuch", "herausfinden", "competitor", "konkurren", "summarize the web", "dig into"];
const TASK = ["todo", "to-do", "to do", "task", "aufgabe", "buy", "kaufen", "call", "anrufen", "email", "mail", "pay", "bezahl", "book ", "buchen", "send", "schick", "fix", "repar", "submit", "abgeben", "renew", "verlänger", "pick up", "abholen", "don't forget", "nicht vergessen", "must", "muss", "need to", "have to"];
const PAGE = ["page", "seite", "note", "notiz", "write", "schreib", "draft", "entwurf", "outline", "gliederung", "list of", "liste", "ideas", "ideen", "journal", "protokoll", "minutes", "meeting notes", "recipe", "rezept", "plan for", "plan für", "checklist", "checkliste"];
const PROJECT_WORD = ["project", "projekt"];

/** Datum aus „tomorrow“, „morgen“, „friday“, „2026-11-14“ (relativ zu `today`). */
export function dueFrom(input: string, today: string): string | undefined {
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(input);
  if (iso) return iso[1];
  const base = new Date(today + "T12:00:00Z");
  const add = (d: number) => new Date(base.getTime() + d * 86_400_000).toISOString().slice(0, 10);
  const s = input.toLowerCase();
  const w = (re: string) => new RegExp(`(^|[^\\p{L}])(${re})($|[^\\p{L}])`, "u").test(s);
  if (w("today|heute")) return add(0);
  if (w("day after tomorrow|übermorgen")) return add(2);
  if (w("tomorrow|morgen") && !w("jeden morgen|every morning")) return add(1);
  if (w("next week|nächste woche")) return add(7);
  const days = [["sunday", "sonntag"], ["monday", "montag"], ["tuesday", "dienstag"], ["wednesday", "mittwoch"], ["thursday", "donnerstag"], ["friday", "freitag"], ["saturday", "samstag"]];
  const now = base.getUTCDay();
  for (let d = 0; d < 7; d++) {
    if (days[d]!.some((n) => s.includes(n))) return add(((d - now + 7) % 7) || 7);
  }
  return undefined;
}

function whenFrom(input: string, today: string): string {
  const s = input.toLowerCase();
  const t = /\b(?:at|um)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|uhr)?/.exec(s) ?? /\b(\d{1,2}):(\d{2})\b/.exec(s);
  let hh = 9, mm = 0;
  if (t) {
    hh = Number(t[1]);
    mm = t[2] ? Number(t[2]) : 0;
    if (t[3] === "pm" && hh < 12) hh += 12;
  }
  const time = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  if (has(s, ["every day", "daily", "täglich", "jeden tag", "every morning", "jeden morgen", "each morning", "each day"])) return `daily ${time}`;
  if (has(s, ["weekday", "werktag"])) return `weekdays ${time}`;
  if (has(s, ["every week", "weekly", "wöchentlich", "jede woche"])) {
    const d = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].find((x, i) => s.includes(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][i]!) || s.includes(["sonntag", "montag", "dienstag", "mittwoch", "donnerstag", "freitag", "samstag"][i]!) || s.includes(" " + x + " "));
    return `weekly ${d ?? "mon"} ${time}`;
  }
  const every = /every (\d+) ?(h|hours?|m|min|minutes?)\b/.exec(s) ?? /alle (\d+) ?(stunden|h|minuten|min)\b/.exec(s);
  if (every) return `every ${every[1]}${every[2]!.startsWith("m") ? "m" : "h"}`;
  return `${dueFrom(input, today) ?? today} ${time}`;
}

const clean = (input: string) => {
  const line = input.trim().split("\n")[0]!.replace(/^(please|bitte)\s+/i, "").replace(/[.!?]+$/, "").trim();
  return line.length > 80 ? line.slice(0, 79).trimEnd() + "…" : line;
};

/** Regeln → Plan (als Objekt). Exportiert für Tests. */
export function rulesPlan(input: string, ctx: { projects: readonly PlannerProject[]; answers: readonly string[]; today: string }): { summary: string; actions: PlanAction[] } {
  const s = input.trim();
  const lower = s.toLowerCase();
  const answered = ctx.answers[ctx.answers.length - 1];
  let project = ctx.projects.find((p) => lower.includes(p.name.toLowerCase()));
  let newProject: string | undefined;
  if (answered) {
    const p = ctx.projects.find((x) => x.name.toLowerCase() === answered.toLowerCase());
    if (p) project = p;
    else if (/^new project$/i.test(answered)) newProject = (clean(s.includes(":") ? s.slice(s.indexOf(":") + 1) : s).split(" ").slice(0, 3).join(" ")) || "New project";
  }
  const pid = project ? { projectID: project.id } : {};
  const title = clean(s);
  const mentionsProject = has(lower, PROJECT_WORD);
  const firstWord = lower.split(/\s+/)[0] ?? "";
  const isQuestion = s.endsWith("?") && !has(lower, SCHEDULE) && !has(lower, RESEARCH);

  if (isQuestion || (QUESTION_START.includes(firstWord) && s.endsWith("?"))) {
    return { summary: "Answers the question", actions: [{ type: "answer", reason: "a pure question", confidence: 0.9, text: `(Scripted answer) You asked: “${title}”. Connect a model in Settings → Agents & AI for real answers.` }] };
  }
  if (has(lower, SCHEDULE) || /\b(every \d+ ?(h|hours?|m|min))|alle \d+ (stunden|minuten)/.test(lower)) {
    const t = title.replace(/^(remind me to|remind me|erinnere mich( daran)?,?( dass| an)?)\s*/i, "");
    return { summary: "Schedules a reminder", actions: [{ type: "schedule", reason: "a time or repetition is named", confidence: 0.85, title: t || title, when: whenFrom(s, ctx.today), prompt: s, ...pid }] };
  }
  if (has(lower, RESEARCH)) {
    return { summary: "Starts a research agent", actions: [{ type: "spawn_agent", reason: "research takes several steps", confidence: 0.85, title: title, instructions: s, estimateEUR: 0.4, ...pid }] };
  }
  // „Based: …“, „Für Publit: …“, „Update for Based …“ → Update ins Projekt
  if (project && (lower.startsWith(project.name.toLowerCase()) || /^(idea|ideas|idee|update|feedback|note|für|for)\b/i.test(s))) {
    return { summary: `Files into ${project.name}`, actions: [{ type: "file_to_project", reason: "an update for the project", confidence: 0.8, note: s, projectID: project.id }] };
  }
  if (mentionsProject && !project && !newProject) {
    const options = [...ctx.projects.slice(0, 2).map((p) => p.name), "New project"];
    return { summary: "Asks which project", actions: [{ type: "ask", reason: "no project named", confidence: 0.6, question: "Which project?", options: options.length >= 2 ? options : ["New project", "File as note"] }] };
  }
  if (newProject) {
    return { summary: `Files into ${newProject}`, actions: [{ type: "file_to_project", reason: "the user asked for a new project", confidence: 0.9, note: s, projectName: newProject }] };
  }
  const due = dueFrom(s, ctx.today);
  const task = { summary: "Adds a task", actions: [{ type: "create_task" as const, reason: "something to do", confidence: 0.85, title, ...(due ? { due } : {}), ...pid }] };
  if (has(lower, TASK)) return task;
  if (has(lower, PAGE)) {
    return { summary: "Creates a page", actions: [{ type: "create_page", reason: "content worth its own page", confidence: 0.8, title, markdown: s.includes("\n") ? s.split("\n").slice(1).join("\n") : "", ...pid }] };
  }
  if (due) return task;
  if (project || newProject) {
    return { summary: `Files into ${project?.name ?? newProject}`, actions: [{ type: "file_to_project", reason: "mentions the project", confidence: 0.8, note: s, ...(project ? { projectID: project.id } : { projectName: newProject! }) }] };
  }
  // unklar: als Seite vorschlagen, aber unsicher → Rückfrage
  return { summary: "Creates a page", actions: [{ type: "create_page", reason: "no clear target", confidence: 0.4, title, markdown: "" }] };
}

/** Deterministischer Planer als Engine (Tests, Golden-Set, E2E). „#invalid“ in der Eingabe → ungültige Ausgabe. */
export class RulesPlannerEngine implements ChatEngine {
  readonly label = "Scripted planner";
  readonly requests: ChatRequest[] = [];
  constructor(private readonly opts: { delayMs?: number } = {}) {}

  async *run(request: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    this.requests.push(request);
    yield { type: "started", model: this.label };
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    if (signal.aborted) return;
    const p = request.prompt;
    const input = p.slice(p.indexOf("INPUT:\n") + 7);
    const today = /TODAY: (\S+)/.exec(p)?.[1] ?? new Date().toISOString().slice(0, 10);
    const projects = JSON.parse(/PROJECTS: (.*)/.exec(p)?.[1] ?? "[]") as PlannerProject[];
    const answers = JSON.parse(/ANSWERS TO YOUR QUESTIONS: (.*)/.exec(p)?.[1] ?? "[]") as string[];
    if (input.includes("#invalid")) {
      yield { type: "text", text: "Sure! Here is my plan: create a page, maybe." };
    } else {
      yield { type: "text", text: "```json\n" + JSON.stringify(rulesPlan(input.replace(/#\w+/g, "").trim(), { projects, answers, today })) + "\n```" };
    }
    yield { type: "usage", inputTokens: Math.ceil(p.length / 4), outputTokens: 60, costUSD: 0, estimated: true, model: this.label };
  }
}
