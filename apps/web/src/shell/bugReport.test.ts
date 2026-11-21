// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Review 21.11.: Das Bildschirmfoto ersetzt `getComputedStyle` nur für seine Dauer – auch wenn sich zwei Fotos überlappen.
import { describe, expect, it } from "vitest";
import { withListedStyles } from "./bugReport.js";

function fakeWindow() {
  const style = { cssText: "color: red", color: "red", getPropertyValue: (p: string) => (p === "color" ? "red" : "") };
  const original = (() => style) as unknown as Window["getComputedStyle"];
  const win = { getComputedStyle: original } as unknown as Window;
  return { win, original };
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("withListedStyles", () => {
  it("liefert während des Fotos ein leeres cssText und stellt danach das Original her", async () => {
    const { win, original } = fakeWindow();
    await withListedStyles(win, async () => {
      const s = win.getComputedStyle({} as Element);
      expect(s.cssText).toBe("");
      expect(s.getPropertyValue("color")).toBe("red");
    });
    expect(win.getComputedStyle).toBe(original);
  });

  it("zwei überlappende Fotos: danach wieder das Original (nicht die Ersatzfunktion)", async () => {
    const { win, original } = fakeWindow();
    const first = deferred();
    const second = deferred();
    const a = withListedStyles(win, () => first.promise);
    const b = withListedStyles(win, () => second.promise);
    first.resolve();
    await a;
    expect(win.getComputedStyle({} as Element).cssText).toBe(""); // das zweite Foto läuft noch
    second.resolve();
    await b;
    expect(win.getComputedStyle).toBe(original);
    expect(win.getComputedStyle({} as Element).cssText).toBe("color: red");
  });

  it("stellt auch nach einem Fehler das Original her", async () => {
    const { win, original } = fakeWindow();
    await expect(withListedStyles(win, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(win.getComputedStyle).toBe(original);
  });
});
