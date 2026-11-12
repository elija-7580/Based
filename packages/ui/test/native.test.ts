import { describe, expect, it } from "vitest";
import {
  daysInMonth, monthGrid, nextEnabled, parseDay, parseTime, place, pointBox, shiftDay, shiftMonth, textActions, tidyEntries, timeSlots, tipPlan, typeahead,
  type MenuEntry,
} from "../src/native/logic.js";

const run = () => undefined;
const view = { width: 1000, height: 600 };

describe("place", () => {
  it("setzt unter den Anker, linksbündig", () => {
    expect(place({ left: 100, top: 50, right: 200, bottom: 80, width: 100, height: 30 }, { width: 160, height: 200 }, view)).toEqual({ left: 100, top: 84, above: false });
  });
  it("klappt nach oben, wenn unten kein Platz ist, und bleibt im Fenster", () => {
    expect(place({ left: 940, top: 500, right: 990, bottom: 530, width: 50, height: 30 }, { width: 160, height: 200 }, view)).toEqual({ left: 832, top: 296, above: true });
  });
  it("passt es weder unten noch oben, bleibt es am unteren Rand sichtbar", () => {
    expect(place(pointBox(10, 300), { width: 100, height: 500 }, view, { gap: 0 })).toEqual({ left: 10, top: 92, above: false });
  });
  it("zentriert Tooltips unter dem Anker und hält den Randabstand", () => {
    expect(place({ left: 0, top: 10, right: 20, bottom: 30, width: 20, height: 20 }, { width: 100, height: 20 }, view, { gap: 6, center: true })).toEqual({ left: 8, top: 36, above: false });
  });
});

describe("Menüs", () => {
  const entries: MenuEntry[] = [{ heading: "Group" }, { label: "Alpha", run }, { label: "Beta", disabled: true, run }, { separator: true }, { label: "Bravo", run }];
  it("überspringt Überschriften, Trenner und gesperrte Einträge, läuft um", () => {
    expect(nextEnabled(entries, -1, 1)).toBe(1);
    expect(nextEnabled(entries, 1, 1)).toBe(4);
    expect(nextEnabled(entries, 4, 1)).toBe(1);
    expect(nextEnabled(entries, 1, -1)).toBe(4);
    expect(nextEnabled([{ separator: true }], -1, 1)).toBe(-1);
  });
  it("findet beim Tippen den nächsten passenden Eintrag", () => {
    expect(typeahead(entries, "b", 0)).toBe(4);
    expect(typeahead(entries, "al", 2)).toBe(1);
    expect(typeahead(entries, "x", 0)).toBe(-1);
  });
  it("räumt Trenner am Rand und doppelte weg", () => {
    expect(tidyEntries([{ separator: true }, { label: "A", run }, { separator: true }, { separator: true }, { label: "B", run }, { separator: true }]).map((e) => ("label" in e ? e.label : "-"))).toEqual(["A", "-", "B"]);
  });
});

describe("Kontextmenü: Text-Einträge", () => {
  const base = { editable: false, secret: false, readOnly: false, hasSelection: false, link: false };
  const ids = (c: Partial<typeof base>) => textActions({ ...base, ...c }).map((a) => (a.disabled ? `(${a.id})` : a.id));
  it("freie Fläche: nichts; markierter Text: kopieren", () => {
    expect(ids({})).toEqual([]);
    expect(ids({ hasSelection: true })).toEqual(["copy"]);
  });
  it("Feld ohne Auswahl: nur einfügen und alles auswählen sind aktiv", () => {
    expect(ids({ editable: true })).toEqual(["(cut)", "(copy)", "paste", "-", "selectAll"]);
  });
  it("Feld mit Auswahl; schreibgeschützt und Passwort sperren passend", () => {
    expect(ids({ editable: true, hasSelection: true })).toEqual(["cut", "copy", "paste", "-", "selectAll"]);
    expect(ids({ editable: true, hasSelection: true, readOnly: true })).toEqual(["(cut)", "copy", "(paste)", "-", "selectAll"]);
    expect(ids({ editable: true, hasSelection: true, secret: true })).toEqual(["(cut)", "(copy)", "paste", "-", "selectAll"]);
  });
  it("Link: öffnen und kopieren zuerst", () => {
    expect(ids({ link: true })).toEqual(["openLink", "copyLink", "-"]);
  });
});

describe("Kalender", () => {
  it("liest ISO und deutsches Format, lehnt unmögliche Tage ab", () => {
    expect(parseDay("2026-11-12")).toBe("2026-11-12");
    expect(parseDay(" 5.3.2027 ")).toBe("2027-03-05");
    expect(parseDay("2026-02-31")).toBeUndefined();
    expect(parseDay("2026-13-01")).toBeUndefined();
    expect(parseDay("2024-02-29")).toBe("2024-02-29");
    expect(parseDay("2026-1")).toBeUndefined();
  });
  it("liest Uhrzeiten", () => {
    expect(parseTime("9:05")).toBe("09:05");
    expect(parseTime("24:00")).toBeUndefined();
    expect(parseTime("9:5")).toBeUndefined();
  });
  it("verschiebt Tage und Monate über Grenzen", () => {
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDay("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftMonth("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftMonth("2026-01-15", -1)).toBe("2025-12-15");
    expect(daysInMonth(2024, 2)).toBe(29);
  });
  it("baut sechs Wochen ab dem Wochenanfang", () => {
    const grid = monthGrid(2026, 11, 1); // November 2026 beginnt an einem Sonntag
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ iso: "2026-10-26", day: 26, inMonth: false });
    expect(grid[6]).toEqual({ iso: "2026-11-01", day: 1, inMonth: true });
    expect(monthGrid(2026, 11, 0)[0]!.iso).toBe("2026-11-01");
    expect(grid.filter((c) => c.inMonth)).toHaveLength(30);
  });
  it("Uhrzeiten im Halbstundentakt", () => {
    const slots = timeSlots(30);
    expect(slots).toHaveLength(48);
    expect(slots.slice(0, 3)).toEqual(["00:00", "00:30", "01:00"]);
    expect(slots.at(-1)).toBe("23:30");
  });
});

describe("Tooltip aus title", () => {
  const base = { title: "Close", tag: "button", hasLabel: false, hasText: false, isField: false, hasFieldLabel: false };
  it("Icon-Knopf ohne Namen: der Titel wird der Name", () => {
    expect(tipPlan(base)).toEqual({ tip: "Close", label: "Close" });
  });
  it("mit Text oder aria-label: der Titel wird Beschreibung", () => {
    expect(tipPlan({ ...base, hasText: true })).toEqual({ tip: "Close", description: "Close" });
    expect(tipPlan({ ...base, hasLabel: true })).toEqual({ tip: "Close", description: "Close" });
  });
  it("Feld: Name nur, wenn kein <label> da ist", () => {
    expect(tipPlan({ ...base, tag: "input", isField: true, hasText: false, hasFieldLabel: true })).toEqual({ tip: "Close", description: "Close" });
    expect(tipPlan({ ...base, tag: "input", isField: true })).toEqual({ tip: "Close", label: "Close" });
  });
  it("leere Titel und iframes bleiben unberührt", () => {
    expect(tipPlan({ ...base, title: "  " })).toBeUndefined();
    expect(tipPlan({ ...base, tag: "iframe" })).toBeUndefined();
  });
});
