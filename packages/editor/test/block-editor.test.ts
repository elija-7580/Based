// ADR 0016: reine Regeln des Block-Editors – Ablageziel beim Ziehen und Filter des Slash-Menüs.
import { describe, expect, it } from "vitest";
import { dropTarget, filterSlash, SLASH_ITEMS } from "../src/index.js";

const row = (id: string, top: number, bottom: number, extra: Partial<{ left: number; right: number; nestable: boolean; columnable: boolean }> = {}) =>
  ({ id, top, bottom, wholeBottom: bottom, left: 100, right: 700, nestable: true, columnable: true, ...extra });

describe("Ablageziel", () => {
  const rows = [row("a", 0, 30), row("b", 30, 60), row("c", 60, 90)];
  it("obere Hälfte = davor, untere = danach, eingerückt = hinein", () => {
    expect(dropTarget(rows, 300, 35)).toEqual({ id: "b", side: "before" });
    expect(dropTarget(rows, 140, 55)).toEqual({ id: "b", side: "after" });
    expect(dropTarget(rows, 300, 55)).toEqual({ id: "b", side: "inside" });
  });
  it("Rand links/rechts = Spalte, nur wo Spalten erlaubt sind", () => {
    expect(dropTarget(rows, 110, 45)).toEqual({ id: "b", side: "left" });
    expect(dropTarget(rows, 690, 45)).toEqual({ id: "b", side: "right" });
    expect(dropTarget([row("x", 0, 30, { columnable: false, nestable: false })], 690, 10)).toEqual({ id: "x", side: "before" });
  });
  it("zwischen Spalten zählt die horizontale Lage", () => {
    const cols = [row("l", 0, 30, { left: 100, right: 380 }), row("r", 0, 30, { left: 420, right: 700 })];
    expect(dropTarget(cols, 500, 25)?.id).toBe("r");
    expect(dropTarget(cols, 200, 25)?.id).toBe("l");
  });
  it("unter dem letzten Block: danach", () => {
    expect(dropTarget(rows, 140, 200)).toEqual({ id: "c", side: "after" });
  });
});

describe("Slash-Menü", () => {
  it("findet über Name und Suchwörter", () => {
    expect(filterSlash(SLASH_ITEMS, "head").map((i) => i.label)).toEqual(["Heading 1", "Heading 2", "Heading 3", "Toggle heading 1", "Toggle heading 2", "Toggle heading 3", "Table of contents"]);
    expect(filterSlash(SLASH_ITEMS, "check").map((i) => i.type)).toEqual(["todo"]);
    expect(filterSlash(SLASH_ITEMS, "").length).toBe(SLASH_ITEMS.length);
  });
});
