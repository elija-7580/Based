// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Feedback 20. 11.: ein „Ziehen“ von ein paar Pixeln auf sich selbst zählt als Klick.
import { describe, expect, it } from "vitest";
import { CLICK_SLOP_PX, noteDragStart, releasedAsClick } from "./clickSlop.js";

describe("clickSlop", () => {
  it("nah am Beginn des Ziehens = Klick, weiter weg = Ziehen", () => {
    noteDragStart({ clientX: 100, clientY: 50 });
    expect(releasedAsClick({ clientX: 104, clientY: 51 })).toBe(true);
    expect(releasedAsClick({ clientX: 100 + CLICK_SLOP_PX + 1, clientY: 50 })).toBe(false);
  });
});
