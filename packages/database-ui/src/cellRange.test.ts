import { describe, expect, it } from "vitest";
import { pv, type PropertySchema } from "@based/core";
import { decodeTSV, encodeTSV, isMulti, planPaste, pasteValue, rangeRect } from "./logic/cellRange.js";

const P = (id: string, type: string, extra: Partial<PropertySchema> = {}) => ({ id, name: id, type, ...extra }) as PropertySchema;

describe("Zellbereich", () => {
  it("Rechteck unabhängig von der Ziehrichtung", () => {
    const order = ["a", "b", "c", "d"];
    expect(rangeRect({ anchor: { rowID: "c", col: 3 }, head: { rowID: "a", col: 1 } }, order)).toEqual({ r0: 0, r1: 2, c0: 1, c1: 3 });
    expect(rangeRect({ anchor: { rowID: "x", col: 0 }, head: { rowID: "a", col: 0 } }, order)).toBeUndefined();
    expect(isMulti({ anchor: { rowID: "a", col: 1 }, head: { rowID: "a", col: 1 } })).toBe(false);
    expect(isMulti({ anchor: { rowID: "a", col: 1 }, head: { rowID: "a", col: 2 } })).toBe(true);
  });

  it("TSV hin und zurück, mit Tab, Zeilenumbruch und Anführungszeichen", () => {
    const t = [["a", "b\tc"], ['say "hi"', "line1\nline2"]];
    expect(decodeTSV(encodeTSV(t))).toEqual(t);
    expect(decodeTSV("x\ty\n1\t2\n")).toEqual([["x", "y"], ["1", "2"]]);
    expect(decodeTSV("x\t\t")).toEqual([["x", "", ""]]);
  });

  it("Werte: Text, Zahl, Checkbox, Option nach Name; Formeln werden übersprungen", () => {
    expect(pasteValue(P("t", "text"), "Hallo")).toEqual(pv("text", "Hallo"));
    expect(pasteValue(P("n", "number"), "abc")).toBeUndefined();
    expect(pasteValue(P("n", "number"), "42")).toEqual(pv("number", 42));
    expect(pasteValue(P("c", "checkbox"), "Yes")).toEqual(pv("checkbox", true));
    expect(pasteValue(P("c", "checkbox"), "No")).toEqual(pv("checkbox", false));
    const sel = P("s", "select", { options: [{ id: "o1", name: "Done", color: "green" }] } as Partial<PropertySchema>);
    expect(pasteValue(sel, "done")).toEqual(pv("select", "o1"));
    expect(pasteValue(sel, "Unbekannt")).toBeUndefined();
    expect(pasteValue(sel, "")).toBeNull();
    expect(pasteValue(P("f", "formula"), "1")).toBeUndefined();
  });

  it("Einfügen: Raster ab links oben, abgeschnitten am Rand; ein Wert füllt den Bereich", () => {
    const props = [P("title", "title"), P("t", "text")];
    const order = ["a", "b"];
    const grid = [["1", "2"], ["3", "4"], ["5", "6"]];
    expect(planPaste(grid, { r0: 0, r1: 0, c0: 1, c1: 1 }, order, props)).toEqual([
      { rowID: "a", propertyID: "t", value: pv("text", "1") },
      { rowID: "b", propertyID: "t", value: pv("text", "3") },
    ]);
    expect(planPaste([["x"]], { r0: 0, r1: 1, c0: 0, c1: 1 }, order, props)).toHaveLength(4);
  });
});
