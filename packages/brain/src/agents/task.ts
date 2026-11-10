// BSD-195 / ADR 0013 Teil 1: der Auftrag. Jede Eingabe an den Hauptagenten wird ZUERST ein Record (auch offline),
// erst danach wird geplant. Die Zustandsmaschine ist rein (kein Store, keine Uhr): `transition(task, event, at)`
// liefert den neuen Auftrag oder wirft bei einem unerlaubten Übergang.
//
//   received → understanding → (question) → proposal | executing → done
//                     │                          │          └→ failed (Try again → received)
//                     └ zweimal ungültiger Plan → filed (als Notiz abgelegt; Try again → received)
//   done → undone (Undo)
//
// Format im Store (ADR 0002: unbekannte Felder bleiben erhalten):
//   { type: "agentTask", parent: "w", text: <Eingabe, gekürzt>, props: { task: TaskData } }
import { z } from "zod";
import { jsonValue } from "@based/core";
import type { ValidPlan } from "./plan.js";

export const TASK_TYPE = "agentTask";

export const TASK_STATES = ["received", "understanding", "question", "proposal", "executing", "done", "failed", "filed", "undone"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Endzustände (laufen nicht von selbst weiter). */
export const isFinished = (s: TaskState) => s === "done" || s === "failed" || s === "filed" || s === "undone";
/** Zustände, in denen der Runner weiterarbeitet (nach Neustart: fortsetzen). */
export const needsWork = (s: TaskState) => s === "received" || s === "understanding" || s === "executing";
/** Wartet auf den Nutzer („Needs you“). */
export const needsUser = (s: TaskState) => s === "question" || s === "proposal";

export type Decision = "auto" | "propose" | "ask" | "deny";

/** Eintrag im Verlauf eines Auftrags (aufklappbar an der Karte). `at` = Swift-Sekunden wie im Store. */
export interface TaskLogEntry {
  at: number;
  text: string;
}

/** Was die Karte für Undo braucht: je berührtem Record der Stand davor und der Stempel danach. */
export interface UndoEntry {
  key: string;
  /** Record vor dem Plan (`null`: neu angelegt). */
  before: unknown;
  /** Stempel nach dem Plan als Text (`null`: gelöscht). Weicht er ab, hat jemand seitdem geändert → bleibt. */
  after: string | null;
}

export interface TaskData {
  v: 1;
  state: TaskState;
  input: string;
  /** Woher: Eingabefeld, Zeitplan, Watch … */
  source?: string;
  createdAt: number;
  updatedAt: number;
  /** Planversuche in diesem Durchgang (ungültige Ausgabe zählt). */
  attempts: number;
  plan?: ValidPlan;
  /** Entscheidung je Aktion (Sicherheitsstufe). */
  decisions?: Record<string, Decision>;
  /** Neue Record-IDs je Aktion, vor dem Ausführen vergeben (Idempotenz: existiert die ID, lief die Aktion schon). */
  targets?: Record<string, string>;
  question?: { actionID?: string; text: string; options: string[] };
  /** Antworten auf Rückfragen (für den nächsten Planversuch). */
  answers?: string[];
  /** Warum ein Vorschlag (über Budget, Regel, Modus). */
  proposal?: string[];
  /** Warum der Auftrag in „received“ wartet (offline, kein Modell). */
  waiting?: string;
  /** Vorschlag bestätigt: auch „propose“-Aktionen laufen. */
  confirmed?: boolean;
  /** Ausgeführte Aktionen. */
  applied?: string[];
  undo?: UndoEntry[];
  /** Antworttext (Aktion answer). */
  answer?: string;
  /** Eine Zeile Ergebnis für die Karte. */
  result?: string;
  error?: string;
  /** Notiz im Eingang (Fallback). */
  noteID?: string;
  projectID?: string;
  /** Run des Hauptagenten für diesen Auftrag (BSD-160). */
  runID?: string;
  /** Wer gerade daran arbeitet (Tab/Gerät) und bis wann (Swift-Sekunden). */
  lease?: { owner: string; until: number };
  usage?: { inputTokens: number; outputTokens: number; costUSD: number };
  log: TaskLogEntry[];
  [key: string]: unknown;
}

export const taskData = z.looseObject({
  v: z.literal(1),
  state: z.enum(TASK_STATES),
  input: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  attempts: z.number().default(0),
  log: z.array(z.looseObject({ at: z.number(), text: z.string() })).default([]),
  plan: jsonValue.optional(),
});

/** Gespeicherten Auftrag lesen; Unbrauchbares → `undefined` (unbekannter Zustand einer neueren Version bleibt im Store). */
export function readTask(raw: unknown): TaskData | undefined {
  const r = taskData.safeParse(raw);
  return r.success ? (r.data as unknown as TaskData) : undefined;
}

export function newTask(input: string, at: number, source?: string): TaskData {
  const t: TaskData = { v: 1, state: "received", input, createdAt: at, updatedAt: at, attempts: 0, log: [{ at, text: "Received" }] };
  if (source) t.source = source;
  return t;
}

/** Wie oft das Modell einen ungültigen Plan liefern darf, bevor der Auftrag als Notiz abgelegt wird (1 Retry). */
export const MAX_PLAN_ATTEMPTS = 2;
const LOG_LIMIT = 50;

export type TaskEvent =
  /** Planen beginnt. */
  | { type: "understand" }
  /** Keine Verbindung / kein Modell: zurück auf „received“, wartet. */
  | { type: "wait"; reason: string }
  /** Gültiger Plan mit Entscheidungen; `next` sagt, wohin (Rückfrage, Vorschlag, Ausführen). */
  | { type: "planned"; plan: ValidPlan; decisions: Record<string, Decision>; next: "question" | "proposal" | "executing"; question?: TaskData["question"]; proposal?: string[] }
  /** Ungültige Modellausgabe: noch ein Versuch, oder (nach MAX_PLAN_ATTEMPTS) Fallback. */
  | { type: "planInvalid"; error: string }
  /** Fallback ausgeführt: als Notiz abgelegt. */
  | { type: "filed"; noteID: string; reason: string }
  /** Antwort auf die Rückfrage → neu planen. */
  | { type: "answer"; option: string }
  /** Vorschlag bestätigt → ausführen. */
  | { type: "confirm" }
  /** Vorschlag/Rückfrage abgelehnt → als Notiz ablegen (nichts geht verloren). */
  | { type: "dismiss"; noteID: string }
  /** Ausgeführt (Ergebnis, Undo-Daten). */
  | { type: "executed"; applied: string[]; undo: UndoEntry[]; result: string; answer?: string; projectID?: string }
  | { type: "fail"; error: string }
  | { type: "undo"; result: string }
  /** „Try again“ nach Fehler oder Fallback. */
  | { type: "retry" };

export class TransitionError extends Error {
  constructor(from: TaskState, event: TaskEvent["type"]) {
    super(`Task cannot go from “${from}” with “${event}”.`);
    this.name = "TransitionError";
  }
}

/** Erlaubte Übergänge: Ereignis → Zustände, aus denen es kommen darf. */
const ALLOWED: Record<TaskEvent["type"], readonly TaskState[]> = {
  understand: ["received", "understanding"],
  wait: ["understanding", "received"],
  planned: ["understanding", "question"],
  planInvalid: ["understanding"],
  filed: ["understanding", "received"],
  answer: ["question"],
  confirm: ["proposal"],
  dismiss: ["question", "proposal"],
  executed: ["executing"],
  fail: ["received", "understanding", "executing", "question", "proposal"],
  undo: ["done"],
  retry: ["failed", "filed", "undone"],
};

export function canTransition(from: TaskState, event: TaskEvent["type"]): boolean {
  return ALLOWED[event].includes(from);
}

function log(t: TaskData, at: number, text: string) {
  t.log = [...t.log, { at, text }].slice(-LOG_LIMIT);
}

/** Der nächste Stand eines Auftrags. Rein: `task` bleibt unverändert. */
export function transition(task: TaskData, event: TaskEvent, at: number): TaskData {
  if (!canTransition(task.state, event.type)) throw new TransitionError(task.state, event.type);
  const t: TaskData = structuredClone(task);
  t.updatedAt = at;
  switch (event.type) {
    case "understand":
      t.state = "understanding";
      delete t.waiting;
      if (task.state === "received") log(t, at, "Understanding");
      break;
    case "wait":
      t.state = "received";
      t.waiting = event.reason;
      delete t.lease;
      if (task.waiting !== event.reason) log(t, at, "Waiting: " + event.reason);
      break;
    case "planned":
      delete t.waiting;
      t.plan = event.plan;
      t.decisions = event.decisions;
      t.state = event.next;
      delete t.error;
      if (event.question) t.question = event.question;
      else delete t.question;
      if (event.proposal) t.proposal = event.proposal;
      else delete t.proposal;
      log(t, at, event.next === "question" ? "Asked back" : event.next === "proposal" ? "Proposal" : "Planned");
      break;
    case "planInvalid":
      t.attempts += 1;
      t.error = event.error;
      log(t, at, `Plan invalid (${t.attempts}/${MAX_PLAN_ATTEMPTS}): ${event.error}`);
      // bleibt in „understanding“: der Runner versucht es noch einmal oder legt ab
      break;
    case "filed":
      t.state = "filed";
      t.noteID = event.noteID;
      t.result = "Filed as a note in Inbox";
      log(t, at, "Filed as a note: " + event.reason);
      break;
    case "answer":
      t.answers = [...(t.answers ?? []), event.option];
      t.state = "understanding";
      t.attempts = 0;
      delete t.question;
      delete t.plan;
      delete t.decisions;
      log(t, at, `Answered: ${event.option}`);
      break;
    case "confirm":
      t.state = "executing";
      t.confirmed = true;
      log(t, at, "Confirmed");
      break;
    case "dismiss":
      t.state = "filed";
      t.noteID = event.noteID;
      t.result = "Filed as a note in Inbox";
      delete t.question;
      log(t, at, "Dismissed, filed as a note");
      break;
    case "executed":
      t.state = "done";
      t.applied = event.applied;
      t.undo = event.undo;
      t.result = event.result;
      if (event.answer !== undefined) t.answer = event.answer;
      if (event.projectID) t.projectID = event.projectID;
      delete t.error;
      delete t.lease;
      log(t, at, "Done: " + event.result);
      break;
    case "fail":
      t.state = "failed";
      t.error = event.error;
      delete t.lease;
      log(t, at, "Failed: " + event.error);
      break;
    case "undo":
      t.state = "undone";
      t.result = event.result;
      delete t.undo;
      log(t, at, event.result);
      break;
    case "retry":
      t.state = "received";
      t.attempts = 0;
      delete t.error;
      delete t.plan;
      delete t.decisions;
      delete t.targets;
      delete t.applied;
      delete t.lease;
      delete t.confirmed;
      log(t, at, "Try again");
      break;
  }
  return t;
}

/** Kurzer Titel aus der Eingabe (für den Record-Text). */
export function taskTitle(input: string): string {
  const line = input.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? line.slice(0, 79).trimEnd() + "…" : line;
}
