// BSD-578: Ein Datum ohne Uhrzeit trägt seinen Kalendertag (`day`) und zeigt in jeder Zeitzone denselben Tag.
// Die Suite läuft in UTC; die Zeitzonen-Fälle starten deshalb einen eigenen Prozess mit TZ (tsx).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  calendarDayStart, contentFingerprint, localDay, MemoryPersistence, normalizeDate, resolveDate, stampDay, withCalendarDays, WorkspaceStore,
  type Block, type WireRecord,
} from "../src/index.js";
import { longDate, parseDate } from "../src/query/value.js";

const at = (y: number, m: number, d: number, h = 0) => (Date.UTC(y, m - 1, d, h) - 978_307_200_000) / 1000;
const row = (values: Block["values"], text: Block["text"] = "Row"): WireRecord =>
  ({ kind: "block", data: { id: "r", type: "page", parent: "w", sk: "a0", text, values, createdAt: 0, updatedAt: 0 } }) as WireRecord;
const dateIn = (s: WorkspaceStore) => (s.blocks.get("r")!.values!.when as { date: { _0: Record<string, unknown> } }).date._0;

describe("Kalendertag", () => {
  it("Hilfen: Tag ↔ Mitternacht, ungültige Tage", () => {
    expect(localDay(at(2026, 11, 18))).toBe("2026-11-18");
    expect(calendarDayStart("2026-11-18")).toBe(at(2026, 11, 18));
    expect(calendarDayStart("2026-02-30")).toBeUndefined();
    expect(calendarDayStart("18.11.2026")).toBeUndefined();
    expect(stampDay({ start: at(2026, 11, 18), end: at(2026, 11, 20), includeTime: false })).toEqual({ start: at(2026, 11, 18), end: at(2026, 11, 20), includeTime: false, day: "2026-11-18", endDay: "2026-11-20" });
    expect(stampDay({ start: at(2026, 11, 18, 9), includeTime: true, day: "x" } as never)).toEqual({ start: at(2026, 11, 18, 9), includeTime: true });
  });

  it("gelesener Text (alle Importe): ohne Uhrzeit mit Tag, mit Uhrzeit ohne", () => {
    expect(parseDate("2026-11-18")).toEqual({ start: at(2026, 11, 18), includeTime: false, day: "2026-11-18" });
    expect(parseDate("November 18, 2026 → November 20, 2026")).toMatchObject({ day: "2026-11-18", endDay: "2026-11-20" });
    expect(parseDate("November 18, 2026 3:00 PM")).toEqual({ start: at(2026, 11, 18, 15), includeTime: true });
  });

  it("eigene Änderung im Store: Zeilenwert und Datums-Erwähnung bekommen den Tag; Ändern setzt ihn neu", () => {
    const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
    s.transact("x", (tx) => tx.put(row({ when: { date: { _0: { start: at(2026, 11, 18), includeTime: false } } } } as never, [{ t: "@", mention: { date: { _0: { start: at(2026, 12, 24), includeTime: false } } } }] as never)));
    expect(dateIn(s)).toEqual({ start: at(2026, 11, 18), includeTime: false, day: "2026-11-18" });
    expect(JSON.stringify(s.blocks.get("r")!.text)).toContain('"day":"2026-12-24"');
    // ein Editor, der nur `start` ändert und den alten Tag stehen lässt
    s.transact("y", (tx) => tx.put(row({ when: { date: { _0: { start: at(2026, 11, 21), includeTime: false, day: "2026-11-18" } } } } as never)));
    expect(dateIn(s).day).toBe("2026-11-21");
    // Uhrzeit dazu: kein Tag mehr
    s.transact("z", (tx) => tx.put(row({ when: { date: { _0: { start: at(2026, 11, 21, 9), includeTime: true, day: "2026-11-21" } } } } as never)));
    expect(dateIn(s)).toEqual({ start: at(2026, 11, 21, 9), includeTime: true });
  });

  it("von einem anderen Gerät (Sync): der Tag des Schreibers bleibt, auch wenn er hier nicht zu `start` passt", () => {
    const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
    // „18. November“ aus Wien: 17.11. 23:00 UTC
    const vienna = { start: at(2026, 11, 17, 23), includeTime: false, day: "2026-11-18" };
    s.applyRemote([{ kind: "block", data: { ...row({ when: { date: { _0: vienna } } } as never).data, stamp: { millis: 5, counter: 0, node: "wien" } } } as WireRecord]);
    expect(dateIn(s)).toEqual(vienna);
    expect(longDate(vienna)).toBe("November 18, 2026");
    expect(resolveDate(vienna).start).toBe(at(2026, 11, 18));
    // eine andere Änderung an der Zeile hier (Titel) lässt das Datum, wie es ist
    s.transact("title", (tx) => tx.put({ kind: "block", data: { ...s.blocks.get("r")!, text: "Renamed" } }));
    expect(dateIn(s)).toEqual(vienna);
    // Kopie der Zeile (kein Vorgänger): der Tag gilt weiter
    expect(normalizeDate(vienna, undefined)).toBe(vienna);
    // wird das Datum hier neu gewählt, gilt der neue Tag
    expect(normalizeDate({ ...vienna, start: at(2026, 11, 25) }, vienna)).toMatchObject({ day: "2026-11-25" });
    expect(withCalendarDays(s.blocks.get("r")!, s.blocks.get("r")!)).toBe(s.blocks.get("r")!);
  });

  it("der Import-Fingerabdruck ändert sich durch den Tag nicht", () => {
    const a = row({ when: { date: { _0: { start: at(2026, 11, 18), includeTime: false } } } } as never).data as Block;
    const b = row({ when: { date: { _0: { start: at(2026, 11, 18), includeTime: false, day: "2026-11-18" } } } } as never).data as Block;
    expect(contentFingerprint(b)).toBe(contentFingerprint(a));
  });

  it("echte Zeitzonen: in Wien geschrieben, in UTC, New York und Tokio derselbe Tag", () => {
    const script = fileURLToPath(new URL("./fixtures/calendar-day-tz.mts", import.meta.url));
    const run = (tz: string, arg = "") => execFileSync("npx", ["tsx", script, arg], { env: { ...process.env, TZ: tz }, encoding: "utf8" }).trim().split("\n").at(-1)!;
    const written = run("Europe/Vienna");
    expect(JSON.parse(written)).toMatchObject({ day: "2026-11-18", includeTime: false });
    for (const tz of ["Europe/Vienna", "UTC", "America/New_York", "Asia/Tokyo", "Pacific/Auckland"]) expect(run(tz, written), tz).toBe("November 18, 2026");
    // ohne das Feld (alte Daten) zeigt es sich: derselbe Wert ist westlich von Wien der Vortag
    const old = JSON.stringify({ ...JSON.parse(written), day: undefined });
    expect(run("UTC", old)).toBe("November 17, 2026");
  }, 60_000);
});
