// ADR 0016: reine Regeln des Block-Editors – Ablageziel beim Ziehen und Filter des Slash-Menüs.
import { describe, expect, it } from "vitest";
import { dropTarget, filterSlash, sectionColor, SLASH_ITEMS } from "../src/index.js";
import { BLOCK_ICON_PATHS, isBlockIcon } from "../src/blocks/icons.js";

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
    expect(filterSlash(SLASH_ITEMS, "head").map((i) => i.label)).toEqual(["Heading 1", "Heading 2", "Heading 3", "Toggle heading 1", "Toggle heading 2", "Toggle heading 3", "Section", "Table of contents"]);
    expect(filterSlash(SLASH_ITEMS, "check").map((i) => i.type)).toEqual(["todo"]);
    expect(filterSlash(SLASH_ITEMS, "").length).toBe(SLASH_ITEMS.length);
  });
  it("jeder Eintrag hat ein Based-Icon (kein Emoji, kein Textzeichen)", () => {
    for (const it of SLASH_ITEMS) expect(isBlockIcon(it.icon), it.label).toBe(true);
    for (const d of Object.values(BLOCK_ICON_PATHS)) expect(d).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
  });
  it("„Section“ legt eine graue, offene Toggle-Überschrift an", () => {
    const item = filterSlash(SLASH_ITEMS, "section")[0]!;
    expect(item.label).toBe("Section");
    expect(sectionColor({ type: item.type, props: item.props })).toBe("grayBackground");
  });
});

describe("Abschnitt", () => {
  it("nur Toggle-Überschriften mit Hintergrundfarbe werden zur Fläche", () => {
    expect(sectionColor({ type: "heading1", props: { toggleable: true, color: "blueBackground" } })).toBe("blueBackground");
    expect(sectionColor({ type: "heading2", props: { toggleable: true, color: "blue" } })).toBeUndefined();
    expect(sectionColor({ type: "heading1", props: { color: "blueBackground" } })).toBeUndefined();
    expect(sectionColor({ type: "toggle", props: { toggleable: true, color: "redBackground" } })).toBeUndefined();
  });
});
