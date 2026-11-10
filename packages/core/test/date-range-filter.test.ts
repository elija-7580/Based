// Datumsfilter auf Zeiträumen (start + end): Das Ende zählt mit. Vorher verglich der Filter nur `start`
// (wie die Swift-Vorlage), sodass ein Zeitraum, der vor dem Fenster beginnt und darin endet, verschwand und
// „is before“/„is on or before“ einen noch laufenden Zeitraum als vergangen zeigten.
import { afterEach, describe, expect, it } from "vitest";
import { MemoryPersistence, QueryEngine, WorkspaceStore, pv, type DatabaseView, type WireRecord } from "../src/index.js";
import { fromJSDate } from "../src/query/value.js";

const stamp = { millis: 1, counter: 0, node: "x" };
/** Lokale Wandzeit → Swift-Sekunden. */
const at = (y: number, m: number, d: number, h = 0, min = 0) => fromJSDate(new Date(y, m - 1, d, h, min));

interface Row { id: string; start: number; end?: number; includeTime?: boolean }

function setup(rows: Row[], now: number) {
  const records: WireRecord[] = [
    { kind: "block", data: { id: "blk", type: "databasePage", parent: "w", sk: "a0", props: { databaseID: "db" }, createdAt: 0, updatedAt: 0, stamp } },
    { kind: "database", data: { id: "db", blockID: "blk", title: "T", createdAt: 0, updatedAt: 0, stamp, properties: [{ id: "title", name: "Name", type: "title" }, { id: "d", name: "When", type: "date" }] } },
  ];
  rows.forEach((r, i) => records.push({
    kind: "block",
    data: {
      id: r.id, type: "page", parent: "d:db", sk: "a" + String(i).padStart(2, "0"), text: r.id, createdAt: 0, updatedAt: 0, stamp,
      values: { d: pv("date", { start: r.start, ...(r.end !== undefined ? { end: r.end } : {}), includeTime: r.includeTime ?? false }) },
    },
  }));
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n" });
  const engine = new QueryEngine(store, { now });
  const run = (op: string, value: unknown) => {
    const view = {
      id: "v", databaseID: "db", blockID: "blk", name: "V", type: "table", sortKey: "a0", createdAt: 0, updatedAt: 0, stamp,
      filter: { combinator: "and", items: [{ condition: { _0: { id: "c", propertyID: "d", op, value } } }] },
    } as unknown as DatabaseView;
    return engine.run(view).rows.map((r) => r.id);
  };
  return { run };
}

const date = (s: number) => ({ date: { _0: s } });
const rel = (r: string) => ({ relative: { _0: r } });

// „Heute“ ist Mittwoch, 10. Juni 2026, 15:00.
const NOW = () => at(2026, 6, 10, 15);
const ROWS = (): Row[] => [
  { id: "single", start: at(2026, 6, 10) },
  { id: "endsInWindow", start: at(2026, 5, 20), end: at(2026, 6, 9) }, // beginnt vor „Past week“, endet darin
  { id: "spansToday", start: at(2026, 6, 8), end: at(2026, 6, 12) },
  { id: "past", start: at(2026, 5, 1), end: at(2026, 5, 3) },
  { id: "future", start: at(2026, 7, 1), end: at(2026, 7, 4) },
];

describe("Datumsfilter auf Zeiträumen", () => {
  it("„is within“ (relativ): ein Zeitraum, dessen Ende im Fenster liegt, gehört dazu", () => {
    const { run } = setup(ROWS(), NOW());
    expect(run("within", rel("pastWeek"))).toEqual(["single", "endsInWindow", "spansToday"]);
    expect(run("within", rel("today"))).toEqual(["single", "spansToday"]);
    expect(run("within", rel("nextWeek"))).toEqual(["single", "spansToday"]);
    expect(run("within", rel("nextMonth"))).toEqual(["single", "spansToday", "future"]);
    expect(run("within", rel("pastYear"))).toEqual(["single", "endsInWindow", "spansToday", "past"]);
  });

  it("„is“: der Tag liegt im Zeitraum (auch am letzten Tag); „is not“ ist das Gegenteil", () => {
    const { run } = setup(ROWS(), NOW());
    expect(run("equals", date(at(2026, 6, 9)))).toEqual(["endsInWindow", "spansToday"]);
    expect(run("equals", date(at(2026, 6, 12)))).toEqual(["spansToday"]);
    expect(run("equals", rel("today"))).toEqual(["single", "spansToday"]);
    expect(run("notEquals", date(at(2026, 6, 9)))).toEqual(["single", "past", "future"]);
  });

  it("„is before“/„is on or before“ richten sich nach dem Ende, „is after“/„is on or after“ nach dem Beginn", () => {
    const { run } = setup(ROWS(), NOW());
    // 8.–12. Juni ist am 10. noch nicht vorbei
    expect(run("before", date(at(2026, 6, 10)))).toEqual(["endsInWindow", "past"]);
    expect(run("onOrBefore", date(at(2026, 6, 10)))).toEqual(["single", "endsInWindow", "past"]);
    expect(run("onOrBefore", date(at(2026, 6, 12)))).toEqual(["single", "endsInWindow", "spansToday", "past"]);
    expect(run("before", date(at(2026, 6, 12)))).toEqual(["single", "endsInWindow", "past"]);
    expect(run("after", date(at(2026, 6, 9)))).toEqual(["single", "future"]);
    expect(run("onOrAfter", date(at(2026, 6, 8)))).toEqual(["single", "spansToday", "future"]);
    expect(run("onOrBefore", rel("yesterday"))).toEqual(["endsInWindow", "past"]);
  });

  it("einzelne Daten (ohne Ende) filtern wie bisher", () => {
    const { run } = setup([{ id: "a", start: at(2026, 6, 9) }, { id: "b", start: at(2026, 6, 10, 23, 30), includeTime: true }, { id: "c", start: at(2026, 6, 11) }], NOW());
    expect(run("equals", rel("today"))).toEqual(["b"]);
    expect(run("before", rel("today"))).toEqual(["a"]);
    expect(run("onOrBefore", rel("today"))).toEqual(["a", "b"]);
    expect(run("after", rel("today"))).toEqual(["c"]);
    expect(run("onOrAfter", rel("today"))).toEqual(["b", "c"]);
    expect(run("within", rel("pastWeek"))).toEqual(["a", "b"]);
  });

  it("mit Uhrzeit: ein Ende um 00:00 gehört zum Vortag, ein Ende nach Mitternacht zum neuen Tag", () => {
    const { run } = setup([
      { id: "untilMidnight", start: at(2026, 6, 9, 22), end: at(2026, 6, 10), includeTime: true },
      { id: "pastMidnight", start: at(2026, 6, 9, 22), end: at(2026, 6, 10, 0, 30), includeTime: true },
      { id: "allDay", start: at(2026, 6, 9), end: at(2026, 6, 10) },
    ], NOW());
    expect(run("equals", rel("today"))).toEqual(["pastMidnight", "allDay"]);
    expect(run("within", rel("today"))).toEqual(["pastMidnight", "allDay"]);
    expect(run("before", rel("today"))).toEqual(["untilMidnight"]);
    expect(run("onOrBefore", rel("yesterday"))).toEqual(["untilMidnight"]);
  });

  it("Ende vor dem Beginn (kaputte Daten) zählt als einzelner Tag", () => {
    const { run } = setup([{ id: "x", start: at(2026, 6, 10), end: at(2026, 6, 1) }], NOW());
    expect(run("equals", rel("today"))).toEqual(["x"]);
    expect(run("before", rel("today"))).toEqual([]);
  });
});

describe("Datumsfilter und Zeitzone", () => {
  const old = process.env.TZ;
  afterEach(() => { process.env.TZ = old; });

  it.each(["Pacific/Auckland", "America/Los_Angeles", "Europe/Vienna"])("Tagesgrenzen gelten im lokalen Kalender (%s)", (tz) => {
    process.env.TZ = tz;
    const { run } = setup([
      { id: "lateEnd", start: at(2026, 6, 5, 9), end: at(2026, 6, 9, 23, 30), includeTime: true },
      { id: "earlyStart", start: at(2026, 6, 11, 0, 15), end: at(2026, 6, 12, 8), includeTime: true },
      { id: "allDay", start: at(2026, 6, 1), end: at(2026, 6, 10) },
    ], at(2026, 6, 10, 0, 5));
    expect(run("equals", rel("today"))).toEqual(["allDay"]);
    expect(run("equals", rel("yesterday"))).toEqual(["lateEnd", "allDay"]);
    expect(run("equals", rel("tomorrow"))).toEqual(["earlyStart"]);
    expect(run("before", rel("today"))).toEqual(["lateEnd"]);
    expect(run("onOrBefore", rel("today"))).toEqual(["lateEnd", "allDay"]);
    expect(run("within", rel("pastWeek"))).toEqual(["lateEnd", "allDay"]);
  });
});
