// BSD-9: Formula-2.0-Lücken – style/link/unstyle mit Formatierung, sort(list, expr), max/min für Daten,
// Filter-Operatoren nach Ergebnistyp.
import { describe, expect, it } from "vitest";
import { Formula, filterOps, type Value } from "../src/index.js";

const ev = (src: string, props: Record<string, Value> = {}) =>
  Formula.evaluate(src, { prop: (n) => props[n] ?? { t: "empty" }, now: 800_000_000, personEmail: (id) => `${id}@example.com`, personName: (id) => `Name ${id}` });

describe("style, link, unstyle", () => {
  it("style setzt Marken und Farben, der Text bleibt rechenbar", () => {
    const v = ev(`"Hallo".style("b", "i", "red_background")`);
    expect(v).toEqual({ t: "string", v: "Hallo", rich: [{ t: "Hallo", m: { b: true, i: true, color: "redBackground" } }] });
    expect(ev(`"Hallo".style("b").length()`)).toEqual({ t: "number", v: 5 });
  });
  it("link ergibt Text mit Link", () => {
    expect(ev(`link("Based", "https://x.y")`)).toEqual({ t: "string", v: "Based", rich: [{ t: "Based", m: { link: "https://x.y" } }] });
  });
  it("unstyle entfernt alles oder einzelne Stile", () => {
    expect(ev(`"x".style("b", "red").unstyle()`)).toEqual({ t: "string", v: "x" });
    expect(ev(`"x".style("b", "red").unstyle("b")`)).toEqual({ t: "string", v: "x", rich: [{ t: "x", m: { color: "red" } }] });
  });
  it("unbekannter Stil ist ein Fehler mit Namen", () => {
    expect(() => ev(`"x".style("glitzer")`)).toThrow(/unknown style “glitzer”/);
  });
});

describe("sort(list, expr)", () => {
  it("sortiert nach dem Ausdruck", () => {
    expect(ev(`[3, 1, 2].sort(-current)`)).toEqual({ t: "list", v: [3, 2, 1].map((v) => ({ t: "number", v })) });
    expect(ev(`["bb", "a", "ccc"].sort(current.length())`)).toEqual({ t: "list", v: ["a", "bb", "ccc"].map((v) => ({ t: "string", v })) });
  });
  it("sort(list) ohne Ausdruck wie bisher", () => {
    expect(ev(`[3, 1, 2].sort()`)).toEqual({ t: "list", v: [1, 2, 3].map((v) => ({ t: "number", v })) });
  });
});

describe("max/min für Daten", () => {
  const props: Record<string, Value> = {
    A: { t: "date", v: { start: 800_000_000, includeTime: false } },
    B: { t: "date", v: { start: 700_000_000, includeTime: false } },
  };
  it("frühestes und spätestes Datum", () => {
    expect(ev(`max(prop("A"), prop("B"))`, props)).toEqual(props.A);
    expect(ev(`min([prop("A"), prop("B")])`, props)).toEqual(props.B);
  });
  it("Zahlen weiter wie bisher", () => {
    expect(ev(`max(1, 5, 3)`)).toEqual({ t: "number", v: 5 });
  });
});

describe("email()", () => {
  it("liefert die Adresse der Person", () => {
    expect(ev(`email(prop("P"))`, { P: { t: "person", v: "u1" } })).toEqual({ t: "string", v: "u1@example.com" });
  });
});

describe("Filter-Operatoren nach Ergebnistyp", () => {
  it("Formel mit Zahl bietet Vergleiche, mit Datum Datumsoperatoren", () => {
    expect(filterOps("formula", "number")).toContain("greater");
    expect(filterOps("formula", "date")).toContain("before");
    expect(filterOps("formula", "boolean")).toEqual(["equals", "notEquals"]);
    expect(filterOps("formula", "text")).toContain("startsWith");
    expect(filterOps("rollup", "list")).toEqual(["contains", "notContains", "isEmpty", "isNotEmpty"]);
    expect(filterOps("number")).toContain("lessOrEqual");
  });
});

describe("Filter auf Zahl-Formel", () => {
  it("Formel > 5 filtert numerisch, Ergebnistyp ist number", async () => {
    const { MemoryPersistence, QueryEngine, WorkspaceStore } = await import("../src/index.js");
    const stamp = { millis: 1, counter: 0, node: "x" };
    const rows = [3, 7, 12].map((n, i) => ({
      kind: "block" as const,
      data: { id: `r${i}`, type: "page", parent: "d:D", sk: `a${i}`, text: `r${i}`, values: { n: { number: { _0: n } } }, createdAt: 0, updatedAt: 0, stamp },
    }));
    const dbRec = {
      kind: "database" as const,
      data: { id: "D", blockID: "B", title: "D", createdAt: 0, updatedAt: 0, stamp,
        properties: [{ id: "title", name: "Name", type: "title" }, { id: "n", name: "N", type: "number" }, { id: "f", name: "Doppelt", type: "formula", formula: 'prop("N") * 2' }] },
    };
    const s = new WorkspaceStore({ persistence: new MemoryPersistence([dbRec as never, ...rows]), node: "n" });
    const e = new QueryEngine(s);
    const db = s.databases.get("D")!;
    const f = db.properties.find((p) => p.id === "f")!;
    expect(e.resultType(db, f)).toBe("number");
    const hits = ["r0", "r1", "r2"].filter((id) => e.matchesCondition(s.blocks.get(id)!, { id: "c", propertyID: "f", op: "greater", value: { number: { _0: 10 } } }, db));
    expect(hits).toEqual(["r1", "r2"]);
  });
});
