// Beispielinhalt wie im Prototyp v6/v8 (Canvas „Based – Design“). Die echten Daten kommen mit dem Store-Anschluss
// (Phase 2, @based/sync + @based/core); bis dahin zeigt die Web-App diese Demo, damit Design geprüft werden kann.
import type { IconName } from "./icons.js";

export interface AgentTask {
  task: string;
  where: string;
  agent: string;
  model: string;
  time: string;
  state: string;
  active: boolean;
  icon: IconName;
}

export const AGENT_TASKS: AgentTask[] = [
  { task: "Statistics study plan", where: "University", agent: "Main", model: "sonnet", time: "9m", state: "Drafting", active: true, icon: "tutor" },
  { task: "Block menu, BSD-112", where: "Based", agent: "Nachtschicht", model: "opus", time: "18m", state: "Needs you", active: true, icon: "night" },
  { task: "Filing 3 voice notes", where: "Inbox", agent: "Sorter", model: "haiku", time: "23:30", state: "Tonight", active: false, icon: "inbox" },
];

export const THIS_WEEK = [
  { day: "Tue 10", title: "Team sync, 14:00" },
  { day: "Thu 12", title: "Essay draft due" },
  { day: "Sat 14", title: "Statistics exam" },
];

export type Screen = "home" | "page" | "db" | "graph" | "settings";

export const RECENT: { title: string; space: string; when: string; go: Screen; icon: IconName }[] = [
  { title: "Lecture 4 — Confidence intervals", space: "University", when: "1 h", go: "page", icon: "page" },
  { title: "Based Backlog", space: "Based", when: "2 h", go: "db", icon: "database" },
  { title: "Team sync – 9 Nov", space: "Work", when: "3 h", go: "home", icon: "calendar" },
  { title: "Graph view", space: "Based", when: "Yesterday", go: "graph", icon: "graph" },
];

export type Status = "Ready" | "In progress" | "Review" | "Backlog";
export interface Row { id: string; title: string; status: Status; area: string; owner: string; updated: string; changed: boolean }

export const ROWS: Row[] = [
  { id: "BSD-112", title: "Block menu on BlockNote", status: "In progress", area: "Editor", owner: "Nachtschicht", updated: "17:02", changed: true },
  { id: "BSD-115", title: "Slash menu: Ask Based", status: "Ready", area: "Editor", owner: "Nachtschicht", updated: "16:40", changed: true },
  { id: "BSD-109", title: "Yjs document per page", status: "In progress", area: "Sync", owner: "Researcher", updated: "16:21", changed: true },
  { id: "BSD-104", title: "Tauri shell + auto-update", status: "Review", area: "Desktop", owner: "Elija", updated: "Sat", changed: false },
  { id: "BSD-118", title: "Meeting notes: speaker labels", status: "Ready", area: "Meetings", owner: "Nachtschicht", updated: "Sat", changed: false },
  { id: "BSD-121", title: "Database chart view", status: "Ready", area: "Database", owner: "Nachtschicht", updated: "Fri", changed: false },
  { id: "BSD-099", title: "Design tokens package", status: "Ready", area: "Design", owner: "Nachtschicht", updated: "Fri", changed: false },
  { id: "BSD-117", title: "Graph view, 5k nodes", status: "Backlog", area: "Graph", owner: "Elija", updated: "Sun", changed: false },
  { id: "BSD-125", title: "Quick capture shortcut", status: "Backlog", area: "Capture", owner: "Elija", updated: "Thu", changed: false },
  { id: "BSD-126", title: "Semantic search with citations", status: "Backlog", area: "AI", owner: "Researcher", updated: "Thu", changed: false },
  { id: "BSD-131", title: "Android via Tauri Mobile", status: "Backlog", area: "Mobile", owner: "—", updated: "Tue", changed: false },
];

export const STATUS_CLASS: Record<Status, string> = { Ready: "ready", "In progress": "progress", Review: "review", Backlog: "neutral" };

/** Graph: p = Projekt (gefüllt), s = ausgewählt, c = vom Agenten geändert, n = Seite (Ring), d = Punkt. */
export const GRAPH_NODES: Record<string, [number, number, string, "p" | "s" | "c" | "n" | "d"]> = {
  based: [400, 320, "Based", "p"], graph: [560, 230, "Graph view", "s"], editor: [270, 210, "Editor", "p"], sync: [300, 450, "Sync", "p"],
  agents: [520, 440, "Agent Brain", "p"], meet: [170, 340, "Meeting notes", "n"], adr: [420, 150, "ADR index", "n"], ts: [650, 340, "TS migration", "c"],
  yjs: [200, 520, "Yjs vs Automerge", "c"], fam: [690, 150, "Family tree", "n"], blk: [150, 140, "BlockNote", "n"], slash: [260, 80, "Slash menu", "c"],
  night: [650, 520, "Nachtschicht", "n"], srv: [410, 545, "based-server", "n"], d1: [740, 260, "", "d"], d2: [90, 450, "", "d"], d3: [350, 50, "", "d"], d4: [560, 600, "", "d"],
};
export const GRAPH_EDGES: [string, string][] = [
  ["based", "graph"], ["based", "editor"], ["based", "sync"], ["based", "agents"], ["based", "adr"], ["based", "ts"], ["graph", "fam"], ["graph", "ts"],
  ["graph", "adr"], ["graph", "agents"], ["editor", "blk"], ["editor", "slash"], ["editor", "meet"], ["sync", "yjs"], ["sync", "srv"], ["agents", "night"],
  ["agents", "srv"], ["ts", "night"], ["fam", "d1"], ["meet", "d2"], ["slash", "d3"], ["agents", "d4"],
];
export const AREAS: [string, number][] = [["Editor", 9], ["Sync", 6], ["Agents", 5], ["Database", 4], ["Graph", 3]];
