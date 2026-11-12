// BSD-215: Datenbank mit 50 000 Zeilen – Laden, Einfügen, Abfrage (Filter, Sortierung, Gruppen), Treffer aus dem Cache,
// eine Zelle ändern und neu abfragen. Grenzwerte großzügig (CI, geteilte Maschine); die gemessenen Zeiten stehen im
// Testbericht (console.info) und im Backlog. Swift-Vergleich: 1,7 s Einfügen / 0,5 s Abfrage / 10 µs aus dem Cache.
import { describe, expect, it } from "vitest";
import { cpuTime, expectWithinBudget } from "./perf-budget.js";
import { MemoryPersistence, QueryEngine, WorkspaceStore, addRow, pv, setValue, type WireRecord } from "../src/index.js";

const N = 50_000;
const stamp = { millis: 1, counter: 0, node: "x" };
const STATUSES = ["todo", "doing", "done", "blocked"];

function records(n: number): WireRecord[] {
  const out: WireRecord[] = [
    { kind: "block", data: { id: "dbblk", type: "databasePage", parent: "w", sk: "a0", props: { databaseID: "db" }, createdAt: 0, updatedAt: 0, stamp } },
    {
      kind: "database",
      data: {
        id: "db", blockID: "dbblk", title: "Big", createdAt: 0, updatedAt: 0, stamp,
        properties: [
          { id: "title", name: "Name", type: "title" },
          { id: "st", name: "Status", type: "status", options: STATUSES.map((s) => ({ id: s, name: s, color: "gray" })), statusGroups: [{ id: "g", name: "All", color: "gray", optionIDs: STATUSES }] },
          { id: "est", name: "Estimate", type: "number" },
          { id: "tags", name: "Tags", type: "multiSelect", options: [{ id: "a", name: "A", color: "blue" }, { id: "b", name: "B", color: "red" }] },
          { id: "note", name: "Note", type: "text" },
        ],
      },
    },
    { kind: "view", data: { id: "v1", databaseID: "db", blockID: "dbblk", name: "Table", type: "table", sortKey: "a0", createdAt: 0, updatedAt: 0, stamp,
      filter: { combinator: "and", items: [{ condition: { _0: { id: "c", propertyID: "st", op: "equals", value: { options: { _0: ["todo", "doing"] } } } } }] },
      sorts: [{ propertyID: "est", ascending: false }],
      groupBy: { propertyID: "st" } } },
  ];
  for (let i = 0; i < n; i++) {
    out.push({ kind: "block", data: {
      id: "r" + i, type: "page", parent: "d:db", sk: "a" + String(i).padStart(6, "0"), text: "Row " + i,
      values: { st: pv("status", STATUSES[i % 4]!), est: pv("number", (i * 7919) % 1000), tags: pv("multiSelect", [i % 3 ? "a" : "b"]), note: pv("text", "note " + (i % 97)) },
      createdAt: i, updatedAt: i, stamp,
    } });
  }
  return out;
}

// BSD-322 Teil 4: CPU-Zeit statt Wanduhr (unter `pnpm -r test` lief das Laden bei voller Maschine 7 s statt 1 s),
// in der CI nur Warnung (perf-budget.ts).
const time = <T>(f: () => T): [T, number] => {
  let r!: T;
  const ms = cpuTime(() => { r = f(); });
  return [r, ms];
};

describe("Große Datenbank (BSD-215)", () => {
  it(`${N.toLocaleString("de")} Zeilen: laden, abfragen, Cache, Zelle ändern`, () => {
    const recs = records(N);
    const [store, load] = time(() => new WorkspaceStore({ persistence: new MemoryPersistence(recs), node: "n" }));
    expect(store.children("d:db").length).toBe(N);

    const engine = new QueryEngine(store);
    const view = store.views.get("v1")!;
    const [first, query] = time(() => engine.run(view));
    expect(first.rows.length).toBe(N / 2);
    expect(first.groups?.length).toBeGreaterThanOrEqual(2);
    const ests = first.rows.slice(0, 50).map((r) => (r.values?.est as { number: { _0: number } }).number._0);
    expect([...ests].sort((a, b) => b - a)).toEqual(ests);

    const [, cached] = time(() => engine.run(view));

    const [, edit] = time(() => setValue(store, "r0", "est", pv("number", 5000)));
    engine.reset();
    const [after, requery] = time(() => engine.run(view));
    expect(after.rows[0]!.id).toBe("r0");

    const [, search] = time(() => engine.run(view, "note 42"));

    console.info(`BSD-215 ${N} Zeilen: Laden ${load.toFixed(0)} ms, Abfrage ${query.toFixed(0)} ms, Cache ${cached.toFixed(2)} ms, Zelle ${edit.toFixed(1)} ms, neu abfragen ${requery.toFixed(0)} ms, Suche ${search.toFixed(0)} ms`);
    expectWithinBudget("50.000 Zeilen", { load: 5000, query: 3000, cached: 50, edit: 200, requery: 3000, search: 3000 }, () => ({ load, query, cached, edit, requery, search }), 1);
  }, 60_000);

  it("Einfügen: 50 000 Zeilen per Sync einspielen, 1 000 einzeln per addRow", () => {
    const recs = records(N);
    const store = new WorkspaceStore({ node: "m" });
    const [, sync] = time(() => store.applyRemote(recs));
    expect(store.children("d:db").length).toBe(N);
    const [, add] = time(() => { for (let i = 0; i < 1000; i++) addRow(store, "db", { title: "New " + i }); });
    expect(store.children("d:db").length).toBe(N + 1000);
    console.info(`BSD-215 Einfügen: Sync ${N} Zeilen ${sync.toFixed(0)} ms, 1000 × addRow ${add.toFixed(0)} ms (${(add / 1000).toFixed(2)} ms je Zeile)`);
    expectWithinBudget("Einfügen", { sync: 5000, add: 10_000 }, () => ({ sync, add }), 1);
  }, 60_000);
});
