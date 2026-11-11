import { describe, expect, it } from "vitest";
import { passWheelToPage } from "./wheelPassThrough.js";

describe("Inline-Datenbank: Rad an die Seite weiterreichen", () => {
  it("senkrecht und nicht aktiv → Seite scrollt", () => {
    expect(passWheelToPage({ deltaX: 0, deltaY: 40, ctrlKey: false }, false)).toBe(true);
  });
  it("seitlich bleibt in der Tabelle", () => {
    expect(passWheelToPage({ deltaX: 40, deltaY: 5, ctrlKey: false }, false)).toBe(false);
  });
  it("nach Klick (aktiv) scrollt die Tabelle selbst", () => {
    expect(passWheelToPage({ deltaX: 0, deltaY: 40, ctrlKey: false }, true)).toBe(false);
  });
  it("Pinch-Zoom (ctrl) nicht anfassen", () => {
    expect(passWheelToPage({ deltaX: 0, deltaY: 40, ctrlKey: true }, false)).toBe(false);
  });
});
