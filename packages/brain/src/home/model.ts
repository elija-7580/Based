// BSD-162/197/133 (Mockup v10): was die Startseite aus den Agenten-Records zeigt – rein, ohne DOM und ohne Uhr
// (`nowMs` kommt von außen). Die Ansicht (apps/web/src/home) zeichnet nur, was hier steht:
//   • Auftragskarte über dem Composer (welcher Auftrag, welcher Zustand, welche Knöpfe, wohin sie fliegt)
//   • Zeitbogen: erledigt links, Needs you am Scheitel, geplant rechts, laufende Läufe im inneren Ring
//   • Kopf (Kosten im Zeitrahmen) und Begrüßungssatz aus echten Ereignissen
//   • Agent-Detail und Projekt-Detail (Kennzahlen, Timeline je Beteiligtem, Protokoll)
import { projectSpentThisMonth } from "../agents/budget.js";
import { actionLabel, type PlannedAction } from "../agents/plan.js";
import { isRunFinished, toMs, type AgentData, type ProjectData, type Rec, type RunData, type ScheduleData } from "../agents/records.js";
import type { AgentSnapshot, TaskView } from "../agents/store.js";
import { isFinished, needsUser, type TaskData } from "../agents/task.js";
import { FRAME_SPAN_MS, type Frame } from "./arc.js";
import type { DueItem } from "./due.js";

const DAY = 86_400_000;

// MARK: Auftragskarte (neun Zustände aus TaskCardsV10, soweit der Kern sie liefert)

export type CardPhase =
  /** 1 · gespeichert, wartet (offline, kein Modell) oder gleich dran. */
  | "received"
  /** 2 · versteht (Skelett). */
  | "understanding"
  /** 3 · Rückfrage mit Knöpfen. */
  | "question"
  /** 4 · Vorschlag (über Budget, Regel, Modus). */
  | "proposal"
  /** führt aus. */
  | "executing"
  /** 5 · sofort erledigt (Undo). */
  | "done"
  /** an einen Agenten übergeben: fliegt in den inneren Ring. */
  | "handedOff"
  /** 6 · reine Frage, Antwort auf der Karte. */
  | "answered"
  /** 9 · Fallback: als Notiz abgelegt oder gescheitert (Try again). */
  | "fallback"
  | "undone";

/** Wohin die Karte fliegt, wenn sie den Composer verlässt. */
export type FlightTarget = "ring" | "done" | "planned" | "none";

export interface CardAction {
  id: string;
  label: string;
}

export interface TaskCardView {
  id: string;
  phase: CardPhase;
  input: string;
  /** Kopfzeile („Main agent · is reading this …“). */
  head: string;
  /** Plan als Aktions-Kacheln (ohne ask/answer). */
  plan: { id: string; label: string; applied: boolean; needsOK: boolean; blocked: boolean }[];
  question?: { text: string; options: string[] };
  /** Gründe des Vorschlags (Budget, Regel …). */
  reasons: string[];
  /** Vorschlag lässt sich bestätigen (nicht alles blockiert). */
  canConfirm: boolean;
  /** Vorschlag hat mit Budget/Limit zu tun → „Raise budget“. */
  aboutBudget: boolean;
  answer?: string;
  result?: string;
  error?: string;
  waiting?: string;
  canUndo: boolean;
  /** Erste neue Seite (Open page). */
  pageID?: string;
  /** Unteragenten-Lauf, den der Auftrag gestartet hat. */
  runID?: string;
  projectID?: string;
  flight: FlightTarget;
}

const firstTarget = (d: TaskData, type: PlannedAction["type"]) => {
  const a = d.plan?.actions.find((x) => x.type === type);
  return a && d.targets ? d.targets[a.id] : undefined;
};

export function taskCard(task: TaskView, runs: readonly Rec<RunData>[], projectName: (id: string) => string | undefined = () => undefined): TaskCardView {
  const d = task.data;
  const spawned = runs.find((r) => r.data.taskID === task.id && r.data.kind === "subagent");
  const actions = d.plan?.actions ?? [];
  const phase: CardPhase = (() => {
    switch (d.state) {
      case "received": return "received";
      case "understanding": return "understanding";
      case "question": return "question";
      case "proposal": return "proposal";
      case "executing": return "executing";
      case "done": return d.answer !== undefined && actions.every((a) => a.type === "answer") ? "answered" : spawned ? "handedOff" : "done";
      case "failed": case "filed": return "fallback";
      case "undone": return "undone";
    }
  })();
  const plan = actions.filter((a) => a.type !== "ask" && a.type !== "answer").map((a) => ({
    id: a.id, label: actionLabel(a, projectName), applied: d.applied?.includes(a.id) ?? false,
    needsOK: d.decisions?.[a.id] === "propose", blocked: d.decisions?.[a.id] === "deny",
  }));
  const reasons = d.proposal ?? [];
  const head = {
    received: d.waiting ? `Saved · waiting: ${d.waiting}` : "Received",
    understanding: "Main agent · is reading this …",
    question: "Main agent · needs one answer",
    proposal: "Main agent · proposes",
    executing: "Main agent · doing it …",
    done: "Done",
    handedOff: "Handed to an agent",
    answered: "Answered",
    fallback: d.state === "filed" ? "Filed as a note in Inbox" : "Didn't work",
    undone: "Undone",
  }[phase];
  const view: TaskCardView = {
    id: task.id, phase, input: d.input, head, plan, reasons,
    canConfirm: plan.some((a) => !a.blocked), aboutBudget: reasons.some((r) => /budget|limit/i.test(r)),
    canUndo: d.state === "done" && (d.undo?.length ?? 0) > 0,
    flight: phase === "handedOff" ? "ring" : actions.some((a) => a.type === "schedule") && phase === "done" ? "planned" : phase === "done" || phase === "fallback" || phase === "answered" ? "done" : "none",
  };
  if (d.state === "question" && d.question) view.question = { text: d.question.text, options: d.question.options };
  if (d.answer !== undefined) view.answer = d.answer;
  if (d.result) view.result = d.result;
  if (d.error && (d.state === "failed" || d.state === "filed")) view.error = d.error;
  if (d.waiting) view.waiting = d.waiting;
  const page = firstTarget(d, "create_page");
  if (page) view.pageID = page;
  if (spawned) view.runID = spawned.id;
  if (d.projectID) view.projectID = d.projectID;
  return view;
}

/** Wie lange eine erledigte Karte (mit Undo) am Composer bleibt, bevor sie ins Ziel fliegt. */
export const CARD_HOLD_MS = 8000;

/**
 * Welche Auftragskarte über dem Composer steht: der neueste Auftrag, solange er noch nicht weiß, wohin er gehört
 * (arbeitet, fragt, schlägt vor, ist gescheitert, ist eine beantwortete Frage) – erledigte Aufträge noch `holdMs`
 * lang (Undo), dann fliegen sie. Weggelegte (`dismissed`) nie. Gibt auch zurück, wann sich das ändert.
 */
export function composerTask(tasks: readonly TaskView[], runs: readonly Rec<RunData>[], nowMs: number, dismissed: ReadonlySet<string>, holdMs = CARD_HOLD_MS): { id?: string; until?: number } {
  const newest = [...tasks].sort((a, b) => b.data.createdAt - a.data.createdAt)[0];
  if (!newest || dismissed.has(newest.id)) return {};
  const card = taskCard(newest, runs);
  switch (card.phase) {
    case "received": case "understanding": case "question": case "proposal": case "executing": case "answered": case "fallback":
      return { id: newest.id };
    case "done": case "undone": {
      const until = toMs(newest.data.updatedAt) + holdMs;
      return until > nowMs ? { id: newest.id, until } : {};
    }
    case "handedOff":
      return {};
  }
}

// MARK: Zeitbogen

export interface ArcCard {
  id: string;
  /** „due“: fällige Zeile aus einer Datenbank (BSD-278); „group“: mehrere Erledigte eines Projekts gebündelt. */
  kind: "task" | "run" | "schedule" | "due" | "group";
  title: string;
  /** Zeit, nach der die Karte auf dem Bogen liegt (ms). */
  atMs: number;
  /** Zweite Zeile („Page ‚X‘“, Ergebnis, „daily 06:30“). */
  detail?: string;
  state: "done" | "failed" | "filed" | "planned";
  pageID?: string;
  taskID?: string;
  runID?: string;
  projectID?: string;
  canUndo?: boolean;
  /** Fällige Zeile: ganztägig bzw. Zeitpunkt schon vorbei (liegt dann auf „now“). */
  allDay?: boolean;
  overdue?: boolean;
  /** Gebündelte Karte: die einzelnen Erledigten (neueste zuerst). */
  items?: ArcCard[];
}

export interface RingCard {
  id: string;
  runID: string;
  title: string;
  kind: RunData["kind"];
  status: RunData["status"];
  startedMs: number;
  model?: string;
  costEUR: number;
  budgetEUR?: number;
  /** Anteil Kosten/Budget (0…1), nur wenn es ein Budget gibt. */
  share?: number;
  projectID?: string;
  taskID?: string;
}

export type NeedsYou =
  | { kind: "approval"; id: string; runID: string; callID: string; title: string; tool: string; projectID?: string }
  | { kind: "task"; id: string; taskID: string; card: TaskCardView }
  | { kind: "stale"; id: string; runID: string; title: string };

export interface Approval {
  runID: string;
  callID: string;
  name: string;
}

export interface HomeModel {
  done: ArcCard[];
  planned: ArcCard[];
  running: RingCard[];
  needsYou: NeedsYou[];
  /** Außerhalb des Zeitrahmens (für „+N earlier/later“). */
  earlier: number;
  later: number;
  /** € im Zeitrahmen (alle Läufe, die darin begonnen haben). */
  costEUR: number;
  /** Abo-Anteil, falls der Hauptagent ein Abo eingetragen hat. */
  subscription?: { name: string; share: number };
  /** Gar nichts da (frischer Workspace): der schöne Leerzustand. */
  empty: boolean;
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Beginn des Zeitrahmens für die Kosten (heute 0:00, Wochenanfang Montag, Monatsanfang). */
export function frameStart(frame: Frame, nowMs: number): number {
  const day = startOfDay(nowMs);
  if (frame === "today") return day;
  const d = new Date(day);
  if (frame === "week") {
    const back = (d.getDay() + 6) % 7;
    return day - back * DAY + (new Date(day - back * DAY).getTimezoneOffset() - d.getTimezoneOffset()) * 60_000;
  }
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

const AGENT_KINDS: ReadonlySet<RunData["kind"]> = new Set(["subagent", "schedule"]);

export interface HomeInput {
  snapshot: AgentSnapshot;
  approvals: readonly Approval[];
  /** Läufe, die gerade in diesem Tab ausgeführt werden (sonst sind „needsYou“-Läufe ohne Freigabe verwaist). */
  active?: readonly string[];
  nowMs: number;
  frame: Frame;
  /** Auftrag am Composer (erscheint nicht noch einmal auf dem Bogen). */
  composerID?: string;
  projectName?: (id: string) => string | undefined;
  /** BSD-278: fällige Zeilen aus den Datenbanken (dueItems im Worker). */
  due?: readonly DueItem[];
}

export function homeModel(i: HomeInput): HomeModel {
  const { snapshot: s, nowMs, frame } = i;
  const span = FRAME_SPAN_MS[frame];
  const name = i.projectName ?? ((id: string) => s.projects.find((p) => p.id === id)?.name);
  const runsOfTask = new Map<string, Rec<RunData>[]>();
  for (const r of s.runs) if (r.data.taskID && AGENT_KINDS.has(r.data.kind)) runsOfTask.set(r.data.taskID, [...(runsOfTask.get(r.data.taskID) ?? []), r]);

  const done: ArcCard[] = [];
  for (const t of s.tasks) {
    if (t.id === i.composerID || !isFinished(t.data.state) || t.data.state === "undone") continue;
    // hat der Auftrag Agenten gestartet, stehen deren Läufe auf dem Bogen
    if (runsOfTask.has(t.id)) continue;
    const card = taskCard(t, s.runs, name);
    const c: ArcCard = {
      id: "task:" + t.id, kind: "task", title: t.title || t.data.input, atMs: toMs(t.data.updatedAt), taskID: t.id,
      state: t.data.state === "done" ? "done" : t.data.state === "filed" ? "filed" : "failed",
      canUndo: card.canUndo,
    };
    const detail = card.answer !== undefined && card.phase === "answered" ? "Answered" : card.result ?? card.error;
    if (detail) c.detail = detail;
    if (card.pageID) c.pageID = card.pageID;
    if (t.data.projectID) c.projectID = t.data.projectID;
    done.push(c);
  }
  const running: RingCard[] = [];
  const needsYou: NeedsYou[] = [];
  for (const a of i.approvals) {
    const r = s.runs.find((x) => x.id === a.runID);
    const n: NeedsYou = { kind: "approval", id: `approval:${a.runID}:${a.callID}`, runID: a.runID, callID: a.callID, title: r?.data.title ?? r?.name ?? "An agent", tool: a.name };
    if (r?.data.projectID) n.projectID = r.data.projectID;
    needsYou.push(n);
  }
  const askingTasks = new Set<string>();
  for (const t of s.tasks) {
    if (t.id !== i.composerID && needsUser(t.data.state)) {
      needsYou.push({ kind: "task", id: "task:" + t.id, taskID: t.id, card: taskCard(t, s.runs, name) });
      askingTasks.add(t.id);
    }
  }
  // BSD-278: was oben als „Needs you“ steht, kreist nicht zusätzlich im inneren Ring
  const asking = (r: Rec<RunData>) => i.approvals.some((a) => a.runID === r.id) || (r.data.taskID !== undefined && askingTasks.has(r.data.taskID) && r.data.kind === "main");
  for (const r of s.runs) {
    const d = r.data;
    if (d.kind === "chat") continue;
    if (d.kind === "main") {
      // Hauptagent: nur, solange er einen Auftrag versteht, der nicht am Composer steht
      if (d.status === "running" && d.taskID !== i.composerID && !asking(r)) running.push(ringCard(r));
      continue;
    }
    if (isRunFinished(d.status)) {
      const c: ArcCard = {
        id: "run:" + r.id, kind: "run", title: d.title || r.name, atMs: toMs(d.endedAt ?? d.startedAt), runID: r.id,
        state: d.status === "done" ? "done" : "failed",
      };
      if (d.result) c.detail = d.result;
      if (d.taskID) c.taskID = d.taskID;
      if (d.projectID) c.projectID = d.projectID;
      done.push(c);
    } else if (d.status === "needsYou" && !i.approvals.some((a) => a.runID === r.id) && !(i.active ?? []).includes(r.id)) {
      needsYou.push({ kind: "stale", id: "stale:" + r.id, runID: r.id, title: d.title || r.name });
    } else if (!asking(r)) running.push(ringCard(r));
  }
  running.sort((a, b) => a.startedMs - b.startedMs || (a.id < b.id ? -1 : 1));

  const planned: ArcCard[] = [];
  for (const sc of s.schedules) {
    if (!sc.data.enabled || sc.data.nextAt === undefined) continue;
    const c: ArcCard = { id: "schedule:" + sc.id, kind: "schedule", title: sc.name || sc.data.prompt, atMs: toMs(sc.data.nextAt), detail: sc.data.when, state: "planned" };
    if (sc.data.projectID) c.projectID = sc.data.projectID;
    if (sc.data.taskID) c.taskID = sc.data.taskID;
    planned.push(c);
  }
  for (const d of i.due ?? []) {
    // ganztägig heute bzw. Uhrzeit vorbei: auf „now“, damit es rechts neben dem Scheitel bleibt
    const overdue = d.dueMs < nowMs;
    const c: ArcCard = { id: "due:" + d.rowID, kind: "due", title: d.title, atMs: Math.max(d.dueMs, nowMs), detail: d.databaseTitle, state: "planned", pageID: d.rowID };
    if (d.allDay) c.allDay = true;
    if (overdue && !d.allDay) c.overdue = true;
    planned.push(c);
  }
  const inDone = groupByProject(done.filter((c) => c.atMs >= nowMs - span), name);
  const inPlanned = planned.filter((c) => c.atMs <= nowMs + span);
  const from = frameStart(frame, nowMs);
  const costEUR = s.runs.reduce((n, r) => (toMs(r.data.startedAt) >= from ? n + (r.data.costEUR || 0) : n), 0);
  const m: HomeModel = {
    done: inDone.sort((a, b) => b.atMs - a.atMs), planned: inPlanned.sort((a, b) => a.atMs - b.atMs), running, needsYou,
    earlier: done.filter((c) => c.atMs < nowMs - span).length, later: planned.length - inPlanned.length,
    costEUR: Math.round(costEUR * 10_000) / 10_000,
    empty: s.tasks.length === 0 && s.runs.filter((r) => r.data.kind !== "chat").length === 0 && s.schedules.length === 0 && (i.due?.length ?? 0) === 0,
  };
  const sub = (s.main as AgentData).subscription;
  if (sub?.share !== undefined) m.subscription = { name: sub.name, share: sub.share };
  return m;
}

/** BSD-278: Erledigtes desselben Projekts (ab zwei Karten) zu einer aufklappbaren Karte „Publit · 3 done“ bündeln. */
export function groupByProject(cards: readonly ArcCard[], projectName: (id: string) => string | undefined): ArcCard[] {
  const byProject = new Map<string, ArcCard[]>();
  for (const c of cards) if (c.projectID) byProject.set(c.projectID, [...(byProject.get(c.projectID) ?? []), c]);
  const out: ArcCard[] = [];
  const grouped = new Set<string>();
  for (const c of cards) {
    const members = c.projectID ? byProject.get(c.projectID)! : undefined;
    if (!members || members.length < 2) {
      out.push(c);
      continue;
    }
    if (grouped.has(c.projectID!)) continue;
    grouped.add(c.projectID!);
    const items = [...members].sort((a, b) => b.atMs - a.atMs);
    const ok = items.filter((x) => x.state === "done").length;
    const failed = items.length - ok;
    out.push({
      id: "group:" + c.projectID, kind: "group", title: `${projectName(c.projectID!) ?? "Project"} · ${ok} done`, atMs: items[0]!.atMs,
      state: ok > 0 ? "done" : "failed", projectID: c.projectID!, items,
      ...(failed > 0 ? { detail: `${failed} not done` } : {}),
    });
  }
  return out;
}

/** BSD-278: Kosten im Kopf nur, wenn etwas angefallen ist oder die Agent-Details eingeschaltet sind. */
export const showCost = (m: Pick<HomeModel, "costEUR" | "subscription">, showDetails: boolean): boolean => showDetails || m.costEUR > 0;

function ringCard(r: Rec<RunData>): RingCard {
  const d = r.data;
  const c: RingCard = { id: "run:" + r.id, runID: r.id, title: d.title || r.name, kind: d.kind, status: d.status, startedMs: toMs(d.startedAt), costEUR: d.costEUR || 0 };
  if (d.model) c.model = d.model;
  if (d.budgetEUR !== undefined) {
    c.budgetEUR = d.budgetEUR;
    c.share = d.budgetEUR > 0 ? Math.min(1, (d.costEUR || 0) / d.budgetEUR) : 0;
  }
  if (d.projectID) c.projectID = d.projectID;
  if (d.taskID) c.taskID = d.taskID;
  return c;
}

// MARK: Kopf und Begrüßung

/** „today 1.84 €“, „this week 0 €“ (+ „· 6% Claude“, wenn ein Abo eingetragen ist). */
export function costLine(m: Pick<HomeModel, "costEUR" | "subscription">, frame: Frame): string {
  const eur = m.costEUR === 0 ? "0.00 €" : m.costEUR < 0.01 ? m.costEUR.toFixed(4) + " €" : m.costEUR.toFixed(2) + " €";
  const label = frame === "today" ? "today" : frame === "week" ? "this week" : "this month";
  const sub = m.subscription ? ` · ${Math.round(m.subscription.share * 100)}% ${m.subscription.name}` : "";
  return `${label} ${eur}${sub}`;
}

export function greetingWord(nowMs: number): string {
  const h = new Date(nowMs).getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** Ein Stück des Begrüßungssatzes; `pageID`/`marker`: Name einer Seite, die ein Agent fertiggestellt hat. */
export interface Segment {
  text: string;
  marker?: boolean;
  pageID?: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Ein Satz aus echten Ereignissen (heute): was fertig wurde, was läuft, was dich braucht, was als Nächstes kommt. */
export function greetingSentence(m: HomeModel, nowMs: number, titleOf: (pageID: string) => string | undefined = () => undefined): Segment[] {
  if (m.empty) return [{ text: "Nothing is running yet. Write what's on your mind below — it becomes a card, and Based files it." }];
  const today = startOfDay(nowMs);
  const doneToday = m.done.flatMap((c) => c.items ?? [c]).filter((c) => c.atMs >= today && c.state === "done");
  const out: Segment[] = [];
  const page = doneToday.find((c) => c.pageID && titleOf(c.pageID));
  if (page) {
    out.push({ text: "Based finished " }, { text: titleOf(page.pageID!)!, marker: true, pageID: page.pageID! });
    const rest = doneToday.length - 1;
    if (rest > 0) out.push({ text: ` and ${plural(rest, "more task", "more tasks")}` });
  } else if (doneToday.length > 0) out.push({ text: `Based finished ${plural(doneToday.length, "task", "tasks")} today` });
  const working = m.running.length;
  if (working > 0) out.push({ text: `${out.length ? "; " : ""}${plural(working, "agent is", "agents are")} working` });
  if (m.needsYou.length > 0) out.push({ text: `${out.length ? "; " : ""}${m.needsYou.length === 1 ? "one thing needs" : `${m.needsYou.length} things need`} you` });
  const next = m.planned[0];
  if (next && next.kind === "due" && (next.allDay || next.overdue)) {
    out.push({ text: `${out.length ? "; " : ""}due today: ${next.title}` });
  } else if (next) {
    const d = new Date(next.atMs);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    out.push({ text: `${out.length ? "; " : ""}next up at ${hhmm}: ${next.title}` });
  }
  if (out.length === 0) return [{ text: "A quiet day so far. Anything you send becomes a card." }];
  const first = out[0]!;
  out[0] = { ...first, text: first.text.charAt(0).toUpperCase() + first.text.slice(1) };
  out.push({ text: "." });
  return out;
}

// MARK: Timeline (Agent-/Projekt-Detail)

export type BarKind = "done" | "running" | "needsYou" | "planned" | "failed";

export interface Bar {
  id: string;
  /** Lage in % der Achse. */
  left: number;
  width: number;
  kind: BarKind;
  label: string;
  /** Punkt statt Balken (Update des Hauptagenten). */
  dot?: boolean;
}

export interface Lane {
  id: string;
  label: string;
  bars: Bar[];
}

export interface Timeline {
  fromMs: number;
  toMs: number;
  /** Jetzt-Linie in %. */
  now: number;
  lanes: Lane[];
}

const barKind = (s: RunData["status"]): BarKind => (s === "running" || s === "queued" ? "running" : s === "needsYou" ? "needsYou" : s === "done" ? "done" : "failed");

function bar(id: string, startMs: number, endMs: number, kind: BarKind, label: string, from: number, to: number, dot = false): Bar | undefined {
  const span = to - from;
  if (span <= 0 || endMs < from || startMs > to) return undefined;
  const a = Math.max(startMs, from), b = Math.min(Math.max(endMs, startMs), to);
  const left = ((a - from) / span) * 100;
  // mindestens sichtbar
  const width = Math.max(((b - a) / span) * 100, dot ? 0 : 0.8);
  const out: Bar = { id, left: Math.round(left * 100) / 100, width: Math.round(Math.min(width, 100 - left) * 100) / 100, kind, label };
  if (dot) out.dot = true;
  return out;
}

/** Timeline eines Laufs: eine Spur je Beteiligtem (Hauptagent des Auftrags, der Lauf, Unterläufe, Geschwister). */
export function runTimeline(runID: string, snapshot: AgentSnapshot, nowMs: number): Timeline | undefined {
  const run = snapshot.runs.find((r) => r.id === runID);
  if (!run) return undefined;
  const related = snapshot.runs.filter((r) => r.id === runID || r.data.parentID === runID || (run.data.taskID !== undefined && r.data.taskID === run.data.taskID) || r.id === run.data.parentID);
  const endOf = (r: Rec<RunData>) => (r.data.endedAt !== undefined ? toMs(r.data.endedAt) : nowMs);
  const sched = run.data.scheduleID ? snapshot.schedules.find((s) => s.id === run.data.scheduleID) : undefined;
  const nextAt = sched?.data.enabled && sched.data.nextAt !== undefined ? toMs(sched.data.nextAt) : undefined;
  let from = Math.min(...related.map((r) => toMs(r.data.startedAt)));
  let to = Math.max(nowMs, ...related.map(endOf));
  const pad = Math.max((to - from) * 0.08, 60_000);
  from -= pad;
  to = Math.max(to + pad, nextAt !== undefined ? nextAt + pad * 2 : 0);
  const order = (r: Rec<RunData>) => (r.data.kind === "main" ? 0 : r.id === runID ? 1 : 2);
  const lanes: Lane[] = [...related].sort((a, b) => order(a) - order(b) || a.data.startedAt - b.data.startedAt).map((r) => {
    const b = bar(r.id, toMs(r.data.startedAt), endOf(r), barKind(r.data.status), STATUS_TEXT[r.data.status], from, to);
    return { id: r.id, label: r.data.kind === "main" ? "Main agent" : r.data.title || r.name, bars: b ? [b] : [] };
  });
  if (sched && nextAt !== undefined) {
    const b = bar("next:" + sched.id, nextAt, nextAt + pad, "planned", "next " + sched.data.when, from, to);
    if (b) lanes.push({ id: "schedule:" + sched.id, label: sched.name || "Schedule", bars: [b] });
  }
  return { fromMs: from, toMs: to, now: ((nowMs - from) / (to - from)) * 100, lanes };
}

const STATUS_TEXT: Record<RunData["status"], string> = { queued: "queued", running: "running", needsYou: "needs you", done: "done", failed: "failed", cancelled: "stopped" };

/** Projekt-Timeline: 2 Wochen zurück, 1 voraus. Spur „Main agent“ (Updates als Punkte), je Agent eine Spur, je Zeitplan eine. */
export function projectTimeline(projectID: string, snapshot: AgentSnapshot, nowMs: number, maxLanes = 6): Timeline {
  const from = startOfDay(nowMs) - 14 * DAY, to = startOfDay(nowMs) + 8 * DAY;
  const lanes: Lane[] = [];
  const updates = snapshot.tasks.filter((t) => t.data.projectID === projectID && t.data.state === "done");
  const mainBars = updates.map((t) => bar("task:" + t.id, toMs(t.data.updatedAt), toMs(t.data.updatedAt), "done", t.title, from, to, true)).filter((b): b is Bar => b !== undefined);
  lanes.push({ id: "main", label: "Main agent", bars: mainBars });
  const byAgent = new Map<string, Rec<RunData>[]>();
  for (const r of snapshot.runs) {
    if (r.data.projectID !== projectID || r.data.kind === "main" || r.data.kind === "chat") continue;
    const key = r.data.title || r.name;
    byAgent.set(key, [...(byAgent.get(key) ?? []), r]);
  }
  for (const [label, rs] of byAgent) {
    const bars = rs.map((r) => bar(r.id, toMs(r.data.startedAt), r.data.endedAt !== undefined ? toMs(r.data.endedAt) : nowMs, barKind(r.data.status), STATUS_TEXT[r.data.status], from, to)).filter((b): b is Bar => b !== undefined);
    lanes.push({ id: "agent:" + label, label, bars });
  }
  for (const s of snapshot.schedules) {
    if (s.data.projectID !== projectID || !s.data.enabled || s.data.nextAt === undefined) continue;
    const at = toMs(s.data.nextAt);
    const b = bar("schedule:" + s.id, at, at + DAY / 3, "planned", s.data.when, from, to);
    lanes.push({ id: "schedule:" + s.id, label: s.name || s.data.prompt, bars: b ? [b] : [] });
  }
  return { fromMs: from, toMs: to, now: ((nowMs - from) / (to - from)) * 100, lanes: lanes.slice(0, maxLanes) };
}

// MARK: Agent-Detail

export interface LiveEntry {
  atMs: number;
  verb: string;
  text: string;
}

/** Protokoll eines Laufs: Lebenslauf des Runs + Verlauf des Auftrags (Verb fett, Rest normal). */
export function liveEntries(run: Rec<RunData>, task: TaskView | undefined): LiveEntry[] {
  const out: LiveEntry[] = [];
  for (const l of task?.data.log ?? []) {
    const [verb] = l.text.split(/[:\s]/);
    out.push({ atMs: toMs(l.at), verb: verb ?? "", text: l.text.slice((verb ?? "").length).replace(/^:\s*/, "").trim() });
  }
  out.push({ atMs: toMs(run.data.startedAt), verb: "Started", text: run.data.instructions ? run.data.instructions.slice(0, 160) : run.data.title });
  if (run.data.endedAt !== undefined) out.push({ atMs: toMs(run.data.endedAt), verb: run.data.status === "done" ? "Done" : run.data.status === "cancelled" ? "Stopped" : "Failed", text: run.data.result ?? "" });
  else if (run.data.status === "needsYou") out.push({ atMs: toMs(run.data.startedAt), verb: "Ask", text: "waiting for your approval" });
  return out.sort((a, b) => a.atMs - b.atMs);
}

export interface Metric {
  label: string;
  value: string;
  sub?: string;
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const eur = (n: number) => (n === 0 ? "0.00 €" : n < 0.01 ? n.toFixed(4) + " €" : n.toFixed(2) + " €");

export interface AgentDetail {
  run: Rec<RunData>;
  task?: TaskView;
  project?: Rec<ProjectData>;
  title: string;
  kindLabel: string;
  status: string;
  metrics: Metric[];
  /** Beteiligte als Baum (Hauptagent → Lauf → Unterläufe). */
  tree: { id: string; label: string; depth: number; status: RunData["status"] }[];
  /** Wo das Ergebnis landet. */
  lands: { label: string; pageID?: string; projectID?: string }[];
  live: LiveEntry[];
  timeline: Timeline;
}

const KIND_LABEL: Record<RunData["kind"], string> = { main: "Main agent", subagent: "Agent", schedule: "Scheduled run", chat: "Chat" };
const STATUS_LABEL = STATUS_TEXT;

export function agentDetail(runID: string, snapshot: AgentSnapshot, nowMs: number, titleOf: (pageID: string) => string | undefined = () => undefined): AgentDetail | undefined {
  const run = snapshot.runs.find((r) => r.id === runID);
  if (!run) return undefined;
  const d = run.data;
  const task = d.taskID ? snapshot.tasks.find((t) => t.id === d.taskID) : undefined;
  const project = d.projectID ? snapshot.projects.find((p) => p.id === d.projectID) : task?.data.projectID ? snapshot.projects.find((p) => p.id === task.data.projectID) : undefined;
  const end = d.endedAt !== undefined ? toMs(d.endedAt) : nowMs;
  const metrics: Metric[] = [
    { label: "Runtime", value: duration(end - toMs(d.startedAt)), sub: STATUS_LABEL[d.status] },
    { label: "Cost", value: eur(d.costEUR || 0), ...(d.budgetEUR !== undefined ? { sub: `of ${eur(d.budgetEUR)} for this run` } : project?.data.budgetEUR !== undefined ? { sub: `project budget ${eur(project.data.budgetEUR)}` } : {}) },
    { label: "Tokens", value: `${d.usage.inputTokens.toLocaleString("en")} in`, sub: `${d.usage.outputTokens.toLocaleString("en")} out` },
  ];
  const changes = task?.data.undo?.length;
  if (changes) metrics.push({ label: "Changes", value: plural(changes, "record", "records"), sub: task?.data.state === "undone" ? "undone" : "can be undone" });
  const tree: AgentDetail["tree"] = [];
  const main = task?.data.runID ? snapshot.runs.find((r) => r.id === task.data.runID) : undefined;
  if (main && main.id !== run.id) tree.push({ id: main.id, label: "Main agent", depth: 0, status: main.data.status });
  tree.push({ id: run.id, label: d.kind === "main" ? "Main agent" : d.title || run.name, depth: tree.length, status: d.status });
  const kids = (id: string, depth: number) => {
    for (const r of snapshot.runs.filter((x) => x.data.parentID === id)) {
      tree.push({ id: r.id, label: r.data.title || r.name, depth, status: r.data.status });
      if (depth < 4) kids(r.id, depth + 1);
    }
  };
  kids(run.id, tree.length);
  const lands: AgentDetail["lands"] = [];
  if (task?.data.targets && task.data.plan) {
    for (const a of task.data.plan.actions) {
      const id = task.data.targets[a.id];
      if (a.type === "create_page" && id) lands.push({ label: titleOf(id) ?? a.title, pageID: id });
    }
  }
  if (project) {
    const l: AgentDetail["lands"][number] = { label: `Project ${project.name}`, projectID: project.id };
    lands.push(l);
  }
  if (lands.length === 0) lands.push({ label: d.kind === "subagent" || d.kind === "schedule" ? "Result on this card and in its transcript" : "Inbox" });
  const timeline = runTimeline(runID, snapshot, nowMs)!;
  const out: AgentDetail = { run, title: d.title || run.name, kindLabel: KIND_LABEL[d.kind], status: STATUS_LABEL[d.status], metrics, tree, lands, live: liveEntries(run, task), timeline };
  if (task) out.task = task;
  if (project) out.project = project;
  return out;
}

// MARK: Projekt-Detail

export interface ProjectDetail {
  project: Rec<ProjectData>;
  metrics: Metric[];
  running: Rec<RunData>[];
  /** Aufträge, die hier gelandet sind (neueste zuerst), mit Ziel. */
  landed: { taskID: string; title: string; target: string; atMs: number; pageID?: string }[];
  /** Updates des Hauptagenten (Ergebnisse von Läufen und eingeordnete Notizen). */
  updates: { id: string; text: string; atMs: number }[];
  upNext: Rec<ScheduleData>[];
  timeline: Timeline;
}

export function projectDetail(projectID: string, snapshot: AgentSnapshot, nowMs: number): ProjectDetail | undefined {
  const project = snapshot.projects.find((p) => p.id === projectID);
  if (!project) return undefined;
  const runs = snapshot.runs.filter((r) => r.data.projectID === projectID && r.data.kind !== "chat");
  const running = runs.filter((r) => !isRunFinished(r.data.status) && r.data.kind !== "main");
  const weekAgo = nowMs - 7 * DAY;
  const tasks = snapshot.tasks.filter((t) => t.data.projectID === projectID);
  const doneWeek = tasks.filter((t) => t.data.state === "done" && toMs(t.data.updatedAt) >= weekAgo).length + runs.filter((r) => r.data.kind !== "main" && r.data.status === "done" && toMs(r.data.endedAt ?? r.data.startedAt) >= weekAgo).length;
  const upNext = snapshot.schedules.filter((s) => s.data.projectID === projectID && s.data.enabled && s.data.nextAt !== undefined).sort((a, b) => a.data.nextAt! - b.data.nextAt!);
  const spent = projectSpentThisMonth(snapshot.runs, projectID, nowMs);
  const month = new Date(nowMs).toLocaleDateString("en-GB", { month: "long" });
  const metrics: Metric[] = [
    { label: "Running", value: String(running.length) },
    { label: "Done this week", value: String(doneWeek) },
    { label: "Planned", value: String(upNext.length) },
    { label: `Budget ${month}`, value: eur(spent), sub: project.data.budgetEUR !== undefined ? `of ${eur(project.data.budgetEUR)}` : "no project budget" },
  ];
  const landed = tasks.filter((t) => t.data.state === "done").sort((a, b) => b.data.updatedAt - a.data.updatedAt).map((t) => {
    const card = taskCard(t, snapshot.runs);
    const target = card.phase === "answered" ? "answered → Questions" : card.runID ? "agent → result" : card.pageID ? "→ page" : card.result ?? "done";
    const l: ProjectDetail["landed"][number] = { taskID: t.id, title: t.title || t.data.input, target, atMs: toMs(t.data.updatedAt) };
    if (card.pageID) l.pageID = card.pageID;
    return l;
  });
  const updates = [
    ...tasks.filter((t) => t.data.state === "done" && t.data.plan?.actions.some((a) => a.type === "file_to_project")).map((t) => ({ id: "task:" + t.id, text: t.data.input, atMs: toMs(t.data.updatedAt) })),
    ...runs.filter((r) => r.data.kind !== "main" && r.data.status === "done" && r.data.result).map((r) => ({ id: "run:" + r.id, text: `${r.data.title}: ${r.data.result}`, atMs: toMs(r.data.endedAt ?? r.data.startedAt) })),
  ].sort((a, b) => b.atMs - a.atMs);
  return { project, metrics, running, landed, updates, upNext, timeline: projectTimeline(projectID, snapshot, nowMs) };
}
