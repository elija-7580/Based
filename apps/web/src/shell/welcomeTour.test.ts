import { describe, expect, it } from "vitest";
import { notYetText } from "../screens/WelcomeTour.js";
import { tourKey, tourSteps } from "./welcomeTour.js";

describe("Einstieg (BSD-551)", () => {
  it("Meeting-Schritt nur, wenn Meetings nicht ausgeblendet sind", () => {
    expect(tourSteps({ meetings: true })).toEqual(["basics", "data", "meetings", "beta"]);
    expect(tourSteps({ meetings: false })).toEqual(["basics", "data", "beta"]);
  });
  it("Pfeiltasten, Return und Escape", () => {
    const body = { tagName: "BODY" };
    expect(tourKey({ key: "ArrowRight" }, body)).toBe("next");
    expect(tourKey({ key: "ArrowLeft" }, body)).toBe("back");
    expect(tourKey({ key: "Enter" }, body)).toBe("next");
    expect(tourKey({ key: "Escape" }, body)).toBe("skip");
    // ein Knopf mit Fokus drückt sich bei Return selbst; Pfeile gehen trotzdem weiter
    expect(tourKey({ key: "Enter" }, { tagName: "BUTTON" })).toBeUndefined();
    expect(tourKey({ key: "ArrowRight" }, { tagName: "BUTTON" })).toBe("next");
    // Tippen und Kürzel bleiben unberührt
    expect(tourKey({ key: "ArrowLeft" }, { tagName: "INPUT" })).toBeUndefined();
    expect(tourKey({ key: "ArrowRight", metaKey: true }, body)).toBeUndefined();
    expect(tourKey({ key: "ArrowRight", shiftKey: true }, body)).toBeUndefined();
    expect(tourKey({ key: "a" }, body)).toBeUndefined();
  });
  it("„Not yet“: AI nur, wo es keinen AI-Schalter gibt (beta)", () => {
    expect(notYetText(false)).toBe("AI, the iPhone app and sync between devices (only through an iCloud folder for now).");
    expect(notYetText(true)).toBe("The iPhone app and sync between devices (only through an iCloud folder for now).");
  });
});
