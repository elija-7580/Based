// BSD-564: Prozent-Spalten speichern den Anteil (0.25) und zeigen, bearbeiten und kopieren 25 %.
import { describe, expect, it } from "vitest";
import { formatNumber, type Block, type PropertySchema } from "@based/core";
import { editText, parseTextInput } from "./logic/values.js";
import { pasteValue } from "./logic/cellRange.js";

const prop: PropertySchema = { id: "p", name: "Share", type: "number", numberFormat: "percent" };
const row = (n: number) => ({ id: "r", values: { p: { number: { _0: n } } } }) as unknown as Block;

describe("Prozent", () => {
  it("Anzeige und Bearbeiten zeigen dieselbe Zahl", () => {
    expect(formatNumber(0.25, "percent")).toBe("25%");
    expect(editText(row(0.25), prop)).toBe("25");
    expect(editText(row(0.07), prop)).toBe("7");
    expect(editText(row(0.25), { ...prop, numberFormat: "number" })).toBe("0.25");
  });
  it("Eingabe „25“ und „25 %“ speichert 0.25; andere Formate bleiben", () => {
    expect(parseTextInput("number", "25", "percent")).toEqual({ number: { _0: 0.25 } });
    expect(parseTextInput("number", "25 %", "percent")).toEqual({ number: { _0: 0.25 } });
    expect(parseTextInput("number", "7", "percent")).toEqual({ number: { _0: 0.07 } });
    expect(parseTextInput("number", "25", "dollar")).toEqual({ number: { _0: 25 } });
    expect(parseTextInput("number", "abc", "percent")).toBeUndefined();
  });
  it("Einfügen von „25%“ in eine Prozent-Spalte", () => {
    expect(pasteValue(prop, "25%")).toEqual({ number: { _0: 0.25 } });
  });
});
