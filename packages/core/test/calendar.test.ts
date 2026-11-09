// BSD-8: Datumslogik für Kalender/Timeline (Zeitzonen, Sommerzeit, Monatsgrenzen, Zeiträume, Spuren, Achse) und
// die Schreib-Operationen (Verschieben behält die Dauer, Ziehen an den Enden, neue Zeile an einem Tag).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryPersistence, QueryEngine, SpanIndex, WorkspaceStore, addMonths, addRowOnDay, calendarDateProperty, calendarEndProperty, canWriteSpan,
  dayFromYMD, dayOf, dayStart, daysInMonth, layoutLanes, monthGrid, moveRowSpan, pv, resizeRowSpan, resizeSpan, rowSpan, rowSpans,
  setRowSpan, shiftSpan, spanLabel, startOfWeek, timelineRange, timelineTicks, unitStart, valueCase, weekStartForLocale, weekdayOf, ymdOf,
  type Block, type DatabaseView, type RowSpan, type WireRecord,
} from "../src/index.js";
import { fromJSDate, toJSDate } from "../src/query/value.js";

/** Lokale Zeit → Swift-Datum. */
const at = (y: number, m: number, d: number, h = 0, mi = 0) => fromJSDate(new Date(y, m - 1, d, h, mi));
const local = (swift: number) => {
  const d = toJSDate(swift);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const D = (y: number, m: number, d: number) => dayFromYMD(y, m - 1, d);

/** Tests in einer anderen Zeitzone (Node übernimmt `process.env.TZ` zur Laufzeit). */
function inZone(tz: string, f: () => void) {
  const old = process.env.TZ;
  process.env.TZ = tz;
  try { f(); } finally { process.env.TZ = old; }
}

describe("Tagesindex", () => {
  it("rechnet im lokalen Kalender, auch an Sommerzeit-Tagen", () => {
    for (const tz of ["UTC", "Europe/Vienna", "America/New_York", "Pacific/Auckland", "Asia/Kolkata", "Pacific/Kiritimati"]) {
      inZone(tz, () => {
        expect(dayOf(at(1970, 1, 1))).toBe(0);
        expect(dayOf(at(2026, 3, 29, 23, 59))).toBe(D(2026, 3, 29));
        expect(dayOf(at(2026, 3, 29, 0, 0))).toBe(D(2026, 3, 29));
        // Mitternacht zurück: jeder Tag beginnt um 00:00 lokal (23- bzw. 25-Stunden-Tage)
        for (const day of [D(2026, 3, 28), D(2026, 3, 29), D(2026, 3, 30), D(2026, 10, 25), D(2026, 11, 1), D(2026, 4, 5), D(2026, 9, 27)]) {
          expect(local(dayStart(day)).endsWith("00:00")).toBe(true);
          expect(dayOf(dayStart(day))).toBe(day);
          expect(dayOf(dayStart(day + 1) - 1)).toBe(day);
        }
      });
    }
  });

  it("derselbe Zeitpunkt liegt je nach Zone an verschiedenen Tagen", () => {
    const instant = fromJSDate(new Date(Date.UTC(2026, 10, 9, 23, 30)));
    inZone("UTC", () => expect(dayOf(instant)).toBe(D(2026, 11, 9)));
    inZone("Europe/Vienna", () => expect(dayOf(instant)).toBe(D(2026, 11, 10)));
    inZone("America/Los_Angeles", () => expect(dayOf(instant)).toBe(D(2026, 11, 9)));
  });

  it("Wochentage, Wochenbeginn, Monate und Schaltjahre", () => {
    expect(weekdayOf(D(2026, 11, 9))).toBe(1); // Montag
    expect(weekdayOf(D(1970, 1, 1))).toBe(4);
    expect(weekdayOf(D(1969, 12, 28))).toBe(0); // negative Indizes
    expect(startOfWeek(D(2026, 11, 15), 1)).toBe(D(2026, 11, 9));
    expect(startOfWeek(D(2026, 11, 15), 0)).toBe(D(2026, 11, 15));
    expect(startOfWeek(D(2026, 11, 14), 6)).toBe(D(2026, 11, 14));
    expect(daysInMonth(2024, 1)).toBe(29);
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2000, 1)).toBe(29);
    expect(daysInMonth(1900, 1)).toBe(28);
    expect(addMonths(D(2026, 1, 31), 1)).toBe(D(2026, 2, 28));
    expect(addMonths(D(2024, 1, 31), 1)).toBe(D(2024, 2, 29));
    expect(addMonths(D(2026, 12, 15), 1)).toBe(D(2027, 1, 15));
    expect(addMonths(D(2026, 1, 15), -1)).toBe(D(2025, 12, 15));
    expect(ymdOf(D(2026, 12, 31) + 1)).toEqual({ year: 2027, month: 0, day: 1 });
  });

  it("Monatsraster: Wochenbeginn Montag/Sonntag, 4 bis 6 Wochen", () => {
    // Februar 2026 beginnt an einem Sonntag
    const mon = monthGrid(2026, 1, 1);
    expect(mon.first).toBe(D(2026, 1, 26));
    expect(mon.weeks).toBe(5);
    const sun = monthGrid(2026, 1, 0);
    expect(sun.first).toBe(D(2026, 2, 1));
    expect(sun.weeks).toBe(4);
    // August 2026: Samstag der 1., 31 Tage → 6 Wochen bei Montag
    expect(monthGrid(2026, 7, 1).weeks).toBe(6);
    expect(mon.monthEnd).toBe(D(2026, 2, 28));
  });

  it("Wochenbeginn aus dem Locale", () => {
    expect(weekStartForLocale("en-US")).toBe(0);
    expect(weekStartForLocale("de-AT")).toBe(1);
    expect(weekStartForLocale("ar-EG")).toBe(6);
    expect(weekStartForLocale("not a locale!")).toBe(1);
  });
});

// MARK: Zeiträume aus Zeilen

const stamp = { millis: 1, counter: 0, node: "x" };
function fixture(rows: Record<string, Record<string, unknown>> = {}) {
  const records: WireRecord[] = [
    { kind: "block", data: { id: "dbblk", type: "databasePage", parent: "w", sk: "a0", props: { databaseID: "db" }, createdAt: 0, updatedAt: 0, stamp } },
    {
      kind: "database",
      data: {
        id: "db", blockID: "dbblk", title: "Plan", createdAt: 0, updatedAt: 0, stamp,
        properties: [
          { id: "title", name: "Name", type: "title" }, { id: "when", name: "When", type: "date" }, { id: "until", name: "Until", type: "date" },
          { id: "f", name: "Later", type: "formula", formula: 'dateAdd(prop("When"), 3, "days")' }, { id: "made", name: "Created", type: "createdTime" },
        ],
      },
    },
    { kind: "view", data: { id: "cal", databaseID: "db", blockID: "dbblk", name: "Calendar", type: "calendar", sortKey: "a0", datePropertyID: "when", createdAt: 0, updatedAt: 0, stamp } },
  ];
  let i = 0;
  for (const [id, values] of Object.entries(rows)) {
    records.push({ kind: "block", data: { id, type: "page", parent: "d:db", sk: "a" + i++, text: id, values: values as never, createdAt: at(2026, 1, 2, 9), updatedAt: 0, stamp } });
  }
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n", now: () => 1000 });
  return { store, engine: new QueryEngine(store), db: store.databases.get("db")!, view: store.views.get("cal")! };
}
const dv = (start: number, end?: number, includeTime = false) => pv("date", end === undefined ? { start, includeTime } : { start, end, includeTime });
const val = (s: WorkspaceStore, row: string, prop: string) => valueCase(s.blocks.get(row)?.values?.[prop])?.[1] as { start: number; end?: number; includeTime: boolean } | undefined;

describe("Zeiträume", () => {
  it("Datums-Property der Ansicht, sonst erste Datums-Property, sonst Zeitstempel", () => {
    const { db, view } = fixture();
    expect(calendarDateProperty(db, view)?.id).toBe("when");
    expect(calendarDateProperty(db, { ...view, datePropertyID: "gone" } as DatabaseView)?.id).toBe("when");
    expect(calendarDateProperty({ ...db, properties: db.properties.filter((p) => p.type !== "date") }, view)?.id).toBe("made");
    expect(calendarEndProperty(db, { ...view, endDatePropertyID: "until" } as DatabaseView)?.id).toBe("until");
  });

  it("Beginn, Ende aus dem Zeitraum oder aus der Ende-Property; Ende vor Beginn zählt eintägig", () => {
    const { engine, db, store } = fixture({
      one: { when: dv(at(2026, 11, 9)) },
      range: { when: dv(at(2026, 11, 9), at(2026, 11, 12)) },
      split: { when: dv(at(2026, 11, 30)), until: dv(at(2026, 12, 2)) },
      backwards: { when: dv(at(2026, 11, 9), at(2026, 11, 1)) },
      midnight: { when: dv(at(2026, 11, 9, 22), at(2026, 11, 11, 0), true) },
      none: {},
    });
    const p = db.properties.find((x) => x.id === "when")!, e = db.properties.find((x) => x.id === "until")!;
    const span = (id: string, end?: typeof e) => rowSpan(engine, db, store.blocks.get(id)!, p, end);
    expect([span("one")!.start, span("one")!.end]).toEqual([D(2026, 11, 9), D(2026, 11, 9)]);
    expect([span("range")!.start, span("range")!.end]).toEqual([D(2026, 11, 9), D(2026, 11, 12)]);
    expect([span("split", e)!.start, span("split", e)!.end]).toEqual([D(2026, 11, 30), D(2026, 12, 2)]); // über die Monatsgrenze
    expect(span("split")!.end).toBe(D(2026, 11, 30));
    expect(span("backwards")!.end).toBe(D(2026, 11, 9));
    expect(span("midnight")!.end).toBe(D(2026, 11, 10)); // bis 24 Uhr am 10.
    expect(span("none")).toBeUndefined();
    const all = rowSpans(engine, db, [...store.blocks.values()].filter((b) => b.parent === "d:db"), p);
    expect(all.dated.map((s) => s.row.id)).toEqual(["one", "range", "split", "backwards", "midnight"]);
    expect(all.undated.map((b) => b.id)).toEqual(["none"]);
  });

  it("berechnete Datums-Properties (Formel, Zeitstempel)", () => {
    const { engine, db, store } = fixture({ a: { when: dv(at(2026, 2, 27)) } });
    const f = db.properties.find((x) => x.id === "f")!, made = db.properties.find((x) => x.id === "made")!;
    expect(rowSpan(engine, db, store.blocks.get("a")!, f)!.start).toBe(D(2026, 3, 2)); // +3 Tage über Monatsende
    expect(rowSpan(engine, db, store.blocks.get("a")!, made)!.start).toBe(D(2026, 1, 2));
  });

  it("Verschieben behält Dauer und Uhrzeit (über die Sommerzeit-Umstellung)", () => {
    inZone("Europe/Vienna", () => {
      const s: RowSpan = { row: {} as Block, start: D(2026, 3, 27), end: D(2026, 3, 28), startAt: at(2026, 3, 27, 10), endAt: at(2026, 3, 28, 18), includeTime: true };
      const moved = shiftSpan(s, 2);
      expect([moved.start, moved.end]).toEqual([D(2026, 3, 29), D(2026, 3, 30)]);
      expect(local(moved.startAt)).toBe("2026-03-29 10:00");
      expect(local(moved.endAt)).toBe("2026-03-30 18:00");
      expect(resizeSpan(s, "end", D(2026, 3, 20)).end).toBe(D(2026, 3, 27)); // nie kürzer als ein Tag
      expect(resizeSpan(s, "start", D(2026, 3, 30)).start).toBe(D(2026, 3, 28));
      expect(local(resizeSpan(s, "end", D(2026, 4, 2)).endAt)).toBe("2026-04-02 18:00");
    });
  });

  it("Beschriftung", () => {
    const s = (a: number, b: number, t = false): RowSpan => ({ row: {} as Block, start: dayOf(a), end: dayOf(b), startAt: a, endAt: b, includeTime: t });
    expect(spanLabel(s(at(2026, 11, 9), at(2026, 11, 9)))).toBe("Nov 9, 2026");
    expect(spanLabel(s(at(2026, 11, 9), at(2026, 11, 12)))).toBe("Nov 9 – Nov 12, 2026");
    expect(spanLabel(s(at(2026, 12, 30), at(2027, 1, 2)))).toBe("Dec 30, 2026 – Jan 2, 2027");
  });
});

describe("Bereichsabfrage und Spuren", () => {
  const span = (id: string, start: number, end = start): RowSpan => ({ row: { id } as Block, start, end, startAt: 0, endAt: 0, includeTime: false });

  it("SpanIndex findet überlappende Zeiträume in Ergebnis-Reihenfolge, auch sehr lange", () => {
    const spans = [span("z", 10), span("a", 3, 5), span("long", -500, 500), span("b", 7), span("c", 20, 30), span("d", 100)];
    const idx = new SpanIndex(spans);
    expect(idx.query(5, 9).map((s) => s.row.id)).toEqual(["a", "long", "b"]);
    expect(idx.query(25, 25).map((s) => s.row.id)).toEqual(["long", "c"]);
    expect(idx.query(600, 700)).toEqual([]);
    expect([idx.min, idx.max]).toEqual([-500, 500]);
    // gegen die naive Suche
    const many = Array.from({ length: 2000 }, (_, i) => span("r" + i, (i * 7919) % 400, ((i * 7919) % 400) + (i % 9 === 0 ? 80 : i % 4)));
    const big = new SpanIndex(many);
    for (const [f, t] of [[0, 6], [100, 106], [395, 500], [-10, -1]] as const) {
      expect(big.query(f, t).map((s) => s.row.id)).toEqual(many.filter((s) => s.start <= t && s.end >= f).map((s) => s.row.id));
    }
  });

  it("layoutLanes: mehrtägige oben, oberste freie Spur, abgeschnittene Enden, „+N mehr“", () => {
    const first = 100;
    const spans = [span("single", 101), span("multi", 99, 102), span("other", 101), span("late", 104, 110), span("third", 101)];
    const l = layoutLanes(spans, first, 7, 2);
    const by = Object.fromEntries(l.placements.map((p) => [p.span.row.id, p]));
    expect(by.multi).toMatchObject({ lane: 0, from: 0, to: 2, continuesBefore: true, continuesAfter: false });
    expect(by.late).toMatchObject({ lane: 0, from: 4, to: 6, continuesBefore: false, continuesAfter: true });
    expect(by.single!.lane).toBe(1);
    expect(by.other!.lane).toBe(2);
    expect(by.third!.lane).toBe(3);
    expect(l.lanes).toBe(4);
    expect(l.perDay).toEqual([1, 4, 1, 0, 1, 1, 1]);
    expect(l.hiddenPerDay).toEqual([0, 2, 0, 0, 0, 0, 0]);
  });
});

describe("Zeitachse", () => {
  it("Ticks je Skala", () => {
    const day = timelineTicks("day", D(2026, 10, 30), D(2026, 11, 2), 1);
    expect(day.minor.map((t) => t.label)).toEqual(["30", "31", "1", "2"]);
    expect(day.major.map((t) => t.label)).toEqual(["October 2026", "November 2026"]);
    const week = timelineTicks("week", D(2026, 11, 1), D(2026, 11, 20), 1);
    expect(week.minor.map((t) => t.day)).toEqual([D(2026, 10, 26), D(2026, 11, 2), D(2026, 11, 9), D(2026, 11, 16)]);
    const month = timelineTicks("month", D(2026, 11, 15), D(2027, 2, 1), 1);
    expect(month.minor.map((t) => t.label)).toEqual(["Nov", "Dec", "Jan", "Feb"]);
    expect(month.major.map((t) => t.label)).toEqual(["2026", "2027"]);
    expect(timelineTicks("quarter", D(2026, 5, 1), D(2027, 1, 1), 1).minor.map((t) => t.label)).toEqual(["Q2", "Q3", "Q4", "Q1"]);
    expect(unitStart("quarter", D(2026, 11, 9), 1)).toBe(D(2026, 10, 1));
  });

  it("Bereich: Daten und heute mit Rand, ausgerichtet, höchstens ±50 Jahre", () => {
    const t = D(2026, 11, 9);
    const r = timelineRange({ min: D(2026, 12, 1), max: D(2027, 1, 10) }, t, "week", 1);
    expect(r.from).toBe(startOfWeek(t - 120, 1));
    expect(r.to).toBeGreaterThanOrEqual(D(2027, 1, 10) + 120);
    expect(weekdayOf(r.to + 1)).toBe(1);
    const far = timelineRange({ min: D(1, 1, 1), max: D(9999, 1, 1) }, t, "month", 1);
    expect(t - far.from).toBeLessThanOrEqual(365 * 50 + 31);
    expect(far.to - t).toBeLessThanOrEqual(365 * 50 + 31);
  });
});

// MARK: Schreiben

describe("Schreib-Operationen", () => {
  let tz: string | undefined;
  beforeEach(() => { tz = process.env.TZ; process.env.TZ = "Europe/Vienna"; });
  afterEach(() => { process.env.TZ = tz; });

  it("moveRowSpan verschiebt Beginn und Ende (ein Undo-Schritt), Uhrzeit bleibt über die Umstellung", () => {
    const { store } = fixture({ r: { when: dv(at(2026, 3, 27, 10), at(2026, 3, 29, 12), true) }, s: { when: dv(at(2026, 11, 30)), until: dv(at(2026, 12, 2)) } });
    expect(moveRowSpan(store, "r", { dateID: "when" }, 2)).toBe(true);
    const v = val(store, "r", "when")!;
    expect([local(v.start), local(v.end!)]).toEqual(["2026-03-29 10:00", "2026-03-31 12:00"]);
    expect(v.includeTime).toBe(true);
    store.undo();
    expect(local(val(store, "r", "when")!.start)).toBe("2026-03-27 10:00");
    // eigene Ende-Property wandert mit
    moveRowSpan(store, "s", { dateID: "when", endID: "until" }, 3);
    expect(local(val(store, "s", "when")!.start)).toBe("2026-12-03 00:00");
    expect(local(val(store, "s", "until")!.start)).toBe("2026-12-05 00:00");
    store.undo();
    expect(local(val(store, "s", "until")!.start)).toBe("2026-12-02 00:00");
    expect(moveRowSpan(store, "s", { dateID: "when" }, 0)).toBe(false);
  });

  it("setRowSpan/resizeRowSpan: Enden ziehen, eintägig ohne Ende, Zeile ohne Datum bekommt eins", () => {
    const { store } = fixture({ r: { when: dv(at(2026, 1, 30), at(2026, 2, 2)) }, n: {}, s: { when: dv(at(2026, 5, 1)), until: dv(at(2026, 5, 3)) } });
    resizeRowSpan(store, "r", { dateID: "when" }, "end", D(2026, 2, 5));
    expect(local(val(store, "r", "when")!.end!)).toBe("2026-02-05 00:00");
    resizeRowSpan(store, "r", { dateID: "when" }, "start", D(2026, 2, 9)); // hinter das Ende: wird eintägig
    expect(val(store, "r", "when")).toEqual({ start: at(2026, 2, 5), includeTime: false });
    resizeRowSpan(store, "r", { dateID: "when" }, "end", D(2026, 2, 1)); // vor den Beginn: bleibt eintägig
    expect(val(store, "r", "when")!.end).toBeUndefined();
    setRowSpan(store, "n", { dateID: "when" }, D(2026, 3, 10), D(2026, 3, 8));
    expect(val(store, "n", "when")).toEqual({ start: at(2026, 3, 8), end: at(2026, 3, 10), includeTime: false });
    resizeRowSpan(store, "s", { dateID: "when", endID: "until" }, "end", D(2026, 5, 10));
    expect(local(val(store, "s", "until")!.start)).toBe("2026-05-10 00:00");
    expect(local(val(store, "s", "when")!.start)).toBe("2026-05-01 00:00");
  });

  it("addRowOnDay legt eine Zeile mit ganztägigem Datum an; canWriteSpan nur für echte Datums-Properties", () => {
    const { store, engine, db, view } = fixture();
    const id = addRowOnDay(store, "db", { dateID: "when" }, D(2026, 11, 9), { values: { title: pv("text", "x") } })!;
    expect(val(store, id, "when")).toEqual({ start: at(2026, 11, 9), includeTime: false });
    const span = rowSpan(engine, db, store.blocks.get(id)!, calendarDateProperty(db, view)!)!;
    expect(span.start).toBe(D(2026, 11, 9));
    const two = addRowOnDay(store, "db", { dateID: "when", endID: "until" }, D(2026, 11, 9), { endDay: D(2026, 11, 11) })!;
    expect(val(store, two, "until")).toEqual({ start: at(2026, 11, 11), includeTime: false });
    store.undo();
    expect(store.blocks.has(two)).toBe(false);
    expect(addRowOnDay(store, "db", { dateID: "f" }, 0)).toBeUndefined();
    expect(canWriteSpan(store, "db", { dateID: "when", endID: "until" })).toBe(true);
    expect(canWriteSpan(store, "db", { dateID: "f" })).toBe(false);
    expect(canWriteSpan(store, "db", { dateID: "made" })).toBe(false);
  });
});
