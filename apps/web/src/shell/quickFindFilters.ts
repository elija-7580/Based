// BSD-206: Filter in Quick Find (⌘K) → Filter der Suche im Kern. Reine Zuordnung, getestet in quickFindFilters.test.ts.
import type { SearchFilters, SearchSort } from "@based/core";

export type DateFilter = "any" | "today" | "week" | "month" | "year";

export interface QuickFindFilters {
  titleOnly: boolean;
  /** Nur die offene Seite und ihre Unterseiten. */
  inPage: boolean;
  date: DateFilter;
  sort: SearchSort;
}

export const DATE_OPTIONS: readonly { id: DateFilter; label: string }[] = [
  { id: "any", label: "Any time" },
  { id: "today", label: "Edited today" },
  { id: "week", label: "Past week" },
  { id: "month", label: "Past 30 days" },
  { id: "year", label: "Past year" },
];

export const SORT_OPTIONS: readonly { id: SearchSort; label: string }[] = [
  { id: "bestMatch", label: "Best match" },
  { id: "lastEditedNewest", label: "Last edited: newest" },
  { id: "lastEditedOldest", label: "Last edited: oldest" },
  { id: "createdNewest", label: "Created: newest" },
  { id: "createdOldest", label: "Created: oldest" },
];

/** Sekunden zwischen 1970 und 2001 – der Store rechnet in Swift-Zeit. */
const SWIFT_EPOCH = 978_307_200;
const DAYS: Record<Exclude<DateFilter, "any" | "today">, number> = { week: 7, month: 30, year: 365 };

export function toSearchFilters(f: QuickFindFilters, currentPage: string | undefined, now = new Date()): SearchFilters {
  const out: SearchFilters = {};
  if (f.titleOnly) out.titleOnly = true;
  if (f.inPage && currentPage !== undefined) out.inPage = currentPage;
  if (f.date === "today") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    out.editedAfter = start.getTime() / 1000 - SWIFT_EPOCH;
  } else if (f.date !== "any") {
    out.editedAfter = now.getTime() / 1000 - DAYS[f.date] * 86_400 - SWIFT_EPOCH;
  }
  return out;
}
