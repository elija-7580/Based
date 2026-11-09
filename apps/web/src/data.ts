// Beispielinhalt wie im Prototyp v6/v8 (Canvas „Based – Design“) für die Teile, die noch keine echten Daten haben:
// Agenten-Abschnitte auf Home und der Graph. Seiten, Seitenleiste und Papierkorb sind echt (BSD-153).
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
