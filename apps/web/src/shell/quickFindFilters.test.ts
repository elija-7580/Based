import { expect, it } from "vitest";
import { toSearchFilters, type QuickFindFilters } from "./quickFindFilters.js";

const base: QuickFindFilters = { titleOnly: false, inPage: false, date: "any", sort: "bestMatch" };
const now = new Date(2026, 10, 10, 15, 30);
const swift = (d: Date) => d.getTime() / 1000 - 978_307_200;

it("ohne Filter bleibt die Suche unverändert", () => {
  expect(toSearchFilters(base, "p")).toEqual({});
});

it("Title only und In this page (nur mit offener Seite)", () => {
  expect(toSearchFilters({ ...base, titleOnly: true, inPage: true }, "p")).toEqual({ titleOnly: true, inPage: "p" });
  expect(toSearchFilters({ ...base, inPage: true }, undefined)).toEqual({});
});

it("Zeitraum in Swift-Zeit: heute ab Mitternacht, sonst rollierend", () => {
  expect(toSearchFilters({ ...base, date: "today" }, undefined, now).editedAfter).toBe(swift(new Date(2026, 10, 10)));
  expect(toSearchFilters({ ...base, date: "week" }, undefined, now).editedAfter).toBe(swift(now) - 7 * 86_400);
  expect(toSearchFilters({ ...base, date: "month" }, undefined, now).editedAfter).toBe(swift(now) - 30 * 86_400);
});
