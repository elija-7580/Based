// BSD-210: Datumswähler der Datums-Erwähnung – Start, Ende (Bereich), Uhrzeit.
import { describe, expect, it } from "vitest";
import { dateFromSwift, dateParts, dateToSwift, withDateParts } from "../src/index.js";

const at = (y: number, m: number, d: number, h = 0, min = 0) => dateToSwift(new Date(y, m - 1, d, h, min));

describe("Datumswähler", () => {
  it("liest Tag und Uhrzeit in lokaler Zeit", () => {
    expect(dateParts({ start: at(2026, 11, 11, 9, 5), includeTime: true })).toEqual({ startDay: "2026-11-11", startTime: "09:05", endDay: undefined, endTime: undefined, includeTime: true });
    expect(dateParts({ start: at(2026, 1, 2), end: at(2026, 1, 5) })).toMatchObject({ startDay: "2026-01-02", endDay: "2026-01-05", includeTime: false });
  });

  it("schreibt Tag, Bereich und Uhrzeit; ohne Uhrzeit Mitternacht; Erinnerung bleibt", () => {
    const v = { start: at(2026, 11, 11), includeTime: false, remind: true };
    const day = withDateParts(v, { startDay: "2026-12-24", startTime: "14:30", includeTime: false });
    expect(day).toEqual({ start: at(2026, 12, 24), includeTime: false, remind: true });
    const timed = withDateParts(v, { startDay: "2026-12-24", startTime: "14:30", includeTime: true });
    expect(dateFromSwift(timed.start).getHours()).toBe(14);
    const range = withDateParts(v, { startDay: "2026-12-24", startTime: "09:00", endDay: "2026-12-26", endTime: "17:00", includeTime: true });
    expect(range).toEqual({ start: at(2026, 12, 24, 9), end: at(2026, 12, 26, 17), includeTime: true, remind: true });
  });

  it("Ende vor dem Start wird getauscht; Unsinn lässt den alten Wert", () => {
    const v = { start: at(2026, 11, 11), includeTime: false };
    expect(withDateParts(v, { startDay: "2026-12-26", startTime: "", endDay: "2026-12-24", includeTime: false })).toEqual({ start: at(2026, 12, 24), end: at(2026, 12, 26), includeTime: false });
    expect(withDateParts(v, { startDay: "", startTime: "", includeTime: false })).toBe(v);
  });
});
