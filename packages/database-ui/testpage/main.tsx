// BSD-155: Testseite für Playwright – eine Aufgaben-Datenbank mit allen Property-Typen und Ansichten,
// standardmäßig 10.000 Zeilen (?rows=N), dazu eine Projekte-Datenbank für Relationen/Rollups.
// ?view=<id> wählt die Ansicht, ?theme=dark das dunkle Theme.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryPersistence, WorkspaceStore, keysBetween, pv, type WireRecord } from "@based/core";
import "@based/design-tokens/tokens.css";
import "../src/styles.css";
import "./page.css";
import { DatabaseView } from "../src/index.js";

const params = new URLSearchParams(location.search);
const N = Number(params.get("rows") ?? 10_000);
if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme")!;

const stamp = { millis: 1, counter: 0, node: "seed" };
const T0 = 784_000_000; // Swift-Datum (Nov 2025)
const opt = (id: string, name: string, color: string) => ({ id, name, color });
const STATUS = [opt("s-backlog", "Backlog", "default"), opt("s-ready", "Ready", "blue"), opt("s-progress", "In progress", "yellow"), opt("s-review", "Review", "pink"), opt("s-done", "Done", "green")];
const PRIO = [opt("p-low", "Low", "gray"), opt("p-mid", "Medium", "orange"), opt("p-high", "High", "red")];
const TAGS = [opt("t-ui", "UI", "blue"), opt("t-core", "Core", "purple"), opt("t-sync", "Sync", "green"), opt("t-docs", "Docs", "brown")];
const WORDS = ["Sync", "Editor", "Board", "Filter", "Search", "Import", "Export", "Graph", "Agent", "Calendar", "Formula", "Relation", "Rollup", "Gallery", "Chart", "Theme"];
const VERBS = ["Fix", "Build", "Polish", "Test", "Port", "Design", "Review", "Measure"];

function seed(): WireRecord[] {
  const out: WireRecord[] = [];
  const view = (data: Record<string, unknown>): WireRecord => ({ kind: "view", data: { databaseID: "tasks", blockID: "tasks-block", createdAt: T0, updatedAt: T0, stamp, ...data } as never });
  out.push(
    { kind: "block", data: { id: "tasks-block", type: "databasePage", parent: "w", sk: "a0", props: { databaseID: "tasks", viewIDs: ["v-table", "v-board", "v-list", "v-gallery", "v-chart", "v-dash", "v-cal"] }, createdAt: T0, updatedAt: T0, stamp } },
    { kind: "block", data: { id: "proj-block", type: "databasePage", parent: "w", sk: "a1", props: { databaseID: "projects", viewIDs: ["pv-table"] }, createdAt: T0, updatedAt: T0, stamp } },
    {
      kind: "database",
      data: {
        id: "projects", blockID: "proj-block", title: "Projects", createdAt: T0, updatedAt: T0, stamp,
        properties: [{ id: "title", name: "Name", type: "title" }, { id: "budget", name: "Budget", type: "number", numberFormat: "euro" }, { id: "tasks", name: "Tasks", type: "relation", relation: { databaseID: "tasks", syncedPropertyID: "project" } }],
      },
    },
    {
      kind: "database",
      data: {
        id: "tasks", blockID: "tasks-block", title: "Based Backlog", createdAt: T0, updatedAt: T0, stamp, nextUniqueID: N + 1,
        properties: [
          { id: "title", name: "Name", type: "title" },
          { id: "uid", name: "ID", type: "uniqueID", idPrefix: "BSD" },
          { id: "status", name: "Status", type: "status", options: STATUS, statusGroups: [
            { id: "g-todo", name: "To-do", color: "gray", optionIDs: ["s-backlog", "s-ready"] },
            { id: "g-prog", name: "In progress", color: "blue", optionIDs: ["s-progress", "s-review"] },
            { id: "g-done", name: "Complete", color: "green", optionIDs: ["s-done"] }] },
          { id: "prio", name: "Priority", type: "select", options: PRIO },
          { id: "tags", name: "Tags", type: "multiSelect", options: TAGS },
          { id: "est", name: "Estimate", type: "number" },
          { id: "cost", name: "Cost", type: "number", numberFormat: "euro" },
          { id: "due", name: "Due", type: "date" },
          { id: "done", name: "Done", type: "checkbox" },
          { id: "owner", name: "Owner", type: "person" },
          { id: "project", name: "Project", type: "relation", relation: { databaseID: "projects", syncedPropertyID: "tasks" } },
          { id: "budget", name: "Project budget", type: "rollup", rollup: { relationPropertyID: "project", targetPropertyID: "budget", function: "sum" } },
          { id: "double", name: "Double estimate", type: "formula", formula: 'prop("Estimate") * 2' },
          { id: "url", name: "Link", type: "url" },
          { id: "email", name: "Email", type: "email" },
          { id: "phone", name: "Phone", type: "phone" },
          { id: "place", name: "Place", type: "place" },
          { id: "files", name: "Files", type: "files" },
          { id: "notes", name: "Notes", type: "text" },
          { id: "created", name: "Created", type: "createdTime" },
          { id: "edited", name: "Edited by", type: "lastEditedBy" },
          { id: "run", name: "Run", type: "button" },
        ],
      },
    },
    view({ id: "v-table", name: "All tasks", type: "table", sortKey: "a0", calculations: { est: "sum", title: "countAll" } }),
    view({ id: "v-board", name: "Board", type: "board", sortKey: "a1", groupBy: { propertyID: "status" }, properties: [{ id: "prio", visible: true }, { id: "uid", visible: true }, { id: "owner", visible: true }] }),
    view({ id: "v-list", name: "List", type: "list", sortKey: "a2", properties: [{ id: "status", visible: true }, { id: "due", visible: true }] }),
    view({ id: "v-gallery", name: "Gallery", type: "gallery", sortKey: "a3", cardCover: { pageContent: {} }, cardSize: "medium", properties: [{ id: "status", visible: true }, { id: "tags", visible: true }] }),
    view({ id: "v-chart", name: "By status", type: "chart", sortKey: "a4", chart: { kind: "bar", xPropertyID: "status", aggregate: "count", dateBucket: "month", showLegend: true, showValues: true, sortByValue: false } }),
    view({ id: "v-dash", name: "Dashboard", type: "dashboard", sortKey: "a5", dashboard: { rows: [{ id: "r1", widgets: [{ id: "w1", viewID: "w-total", width: 4 }, { id: "w2", viewID: "w-donut", width: 8 }] }, { id: "r2", height: 260, widgets: [{ id: "w3", viewID: "w-table", width: 12 }] }] } }),
    view({ id: "w-total", name: "Total estimate", type: "chart", sortKey: "a0", widgetOf: "v-dash", chart: { kind: "number", yPropertyID: "est", aggregate: "sum", dateBucket: "month", showLegend: true, showValues: true, sortByValue: false } }),
    view({ id: "w-donut", name: "By priority", type: "chart", sortKey: "a0", widgetOf: "v-dash", chart: { kind: "donut", xPropertyID: "prio", aggregate: "count", dateBucket: "month", showLegend: true, showValues: true, sortByValue: false } }),
    view({ id: "w-table", name: "Projects", type: "table", sortKey: "a0", widgetOf: "v-dash", databaseID: "projects", blockID: "proj-block" }),
    view({ id: "v-cal", name: "Calendar", type: "calendar", sortKey: "a6", datePropertyID: "due" }),
    { kind: "view", data: { id: "pv-table", databaseID: "projects", blockID: "proj-block", name: "Projects", type: "table", sortKey: "a0", createdAt: T0, updatedAt: T0, stamp } },
  );
  const projects = ["Alpha", "Beta", "Gamma", "Delta"];
  const backlinks: string[][] = projects.map(() => []);
  const keys = keysBetween(N, undefined, undefined);
  for (let i = 0; i < N; i++) {
    const id = `row-${i}`;
    const p = i % 7 === 0 ? i % projects.length : -1;
    if (p >= 0) backlinks[p]!.push(id);
    const values: Record<string, unknown> = {
      uid: pv("uniqueID", i + 1),
      status: pv("status", STATUS[i % STATUS.length]!.id),
      prio: pv("select", PRIO[(i * 7) % 3]!.id),
      tags: pv("multiSelect", [TAGS[i % 4]!.id, ...(i % 3 === 0 ? [TAGS[(i + 1) % 4]!.id] : [])]),
      est: pv("number", (i * 37) % 13 + 1),
      due: pv("date", { start: T0 + (i % 120) * 86_400, includeTime: false }),
      done: pv("checkbox", i % 5 === 4),
      owner: pv("person", [i % 2 ? "me" : "lena"]),
    };
    if (p >= 0) values.project = pv("relation", [`proj-${p}`]);
    if (i % 4 === 0) values.url = pv("url", `based.app/t/${i}`);
    if (i % 9 === 0) values.notes = pv("text", "Follow up with design");
    out.push({
      kind: "block",
      data: {
        id, type: "page", parent: "d:tasks", sk: keys[i]!, text: `${VERBS[i % VERBS.length]} ${WORDS[(i * 3) % WORDS.length]} ${i + 1}`, values: values as never,
        createdAt: T0 + i * 60, updatedAt: T0 + i * 60, createdBy: "me", updatedBy: i % 11 === 0 ? "agent:based" : "me", stamp,
      },
    });
  }
  projects.forEach((name, i) => out.push({
    kind: "block",
    data: { id: `proj-${i}`, type: "page", parent: "d:projects", sk: "a" + i, text: name, values: { budget: pv("number", (i + 1) * 1000), tasks: pv("relation", backlinks[i]!) }, createdAt: T0, updatedAt: T0, stamp },
  }));
  return out;
}

const t0 = performance.now();
// WorkspaceStore sortiert seinen Kinder-Index beim Laden pro Record neu (O(n² log n), ~3 s für 10.000 Zeilen,
// siehe Abschlussbericht BSD-155). Die Testseite füllt die Zeilen deshalb direkt ein und baut den Index einmal.
const records = seed();
const store = new WorkspaceStore({ persistence: new MemoryPersistence(records.filter((r) => r.kind !== "block")), node: "testpage" });
for (const r of records) if (r.kind === "block") store.blocks.set(r.data.id, r.data);
(store as unknown as { rebuildChildIndex(): void }).rebuildChildIndex();
const seedMs = performance.now() - t0;
declare global { interface Window { __store: WorkspaceStore; __seedMs: number; __opened: string[] } }
window.__store = store;
window.__seedMs = seedMs;
window.__opened = [];

function App() {
  const [view, setView] = useState(params.get("view") ?? undefined);
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <div className="page">
      <DatabaseView store={store} databaseID="tasks" viewID={view} onViewChange={setView}
        onOpenPage={(id) => { window.__opened.push(id); setOpened(id); }} />
      <p className="opened" data-testid="opened">{opened ? `Opened ${opened}` : ""}</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
