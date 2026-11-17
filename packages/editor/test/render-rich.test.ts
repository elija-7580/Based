// @vitest-environment jsdom
// BSD-400: renderRich ändert beim Tippen nur den Text der vorhandenen Knoten (gleicher Aufbau), sonst baut es neu.
import { describe, expect, it } from "vitest";
import type { RichText } from "@based/core";
import { renderRich } from "../src/blocks/dom.js";

const fresh = (text: RichText) => {
  const el = document.createElement("div");
  renderRich(el, text);
  return el.innerHTML;
};

describe("renderRich", () => {
  it("gleicher Aufbau: Textknoten bleiben dieselben, Ergebnis wie neu gezeichnet", () => {
    const el = document.createElement("div");
    const a: RichText = [{ t: "Hello " }, { t: "bold", m: { b: true } }, { t: " tail" }];
    renderRich(el, a);
    const nodes = [...el.childNodes];
    const b: RichText = [{ t: "Hello " }, { t: "bold", m: { b: true } }, { t: " tail!" }];
    renderRich(el, b);
    expect([...el.childNodes]).toEqual(nodes);
    expect(el.childNodes[2]).toBe(nodes[2]);
    expect(el.innerHTML).toBe(fresh(b));
  });

  it("anderer Aufbau (neue Auszeichnung, leer, Zeilenumbruch): neu gezeichnet und richtig", () => {
    const el = document.createElement("div");
    renderRich(el, "plain");
    const first = el.firstChild;
    const marked: RichText = [{ t: "pl" }, { t: "ain", m: { i: true } }];
    renderRich(el, marked);
    expect(el.firstChild).not.toBe(first);
    expect(el.innerHTML).toBe(fresh(marked));
    renderRich(el, "");
    expect(el.innerHTML).toBe("<br>");
    renderRich(el, "a\n");
    expect(el.innerHTML).toBe(fresh("a\n"));
  });

  it("Klassen zählen zum Aufbau: andere Farbe wird nicht nur als Text übernommen", () => {
    const el = document.createElement("div");
    renderRich(el, [{ t: "x", m: { color: "red" } }]);
    const blue: RichText = [{ t: "x", m: { color: "blue" } }];
    renderRich(el, blue);
    expect(el.innerHTML).toBe(fresh(blue));
  });
});
