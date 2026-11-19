// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-607: Das Chat-Panel schwebt, sobald die Hauptspalte daneben unter MAIN_MIN fiele.
import { describe, expect, it } from "vitest";
import { chatFloats, MAIN_MIN } from "./dockLayout.js";

describe("chatFloats", () => {
  it("900 × 600 mit Seitenleiste (232) und Panel (420): schwebt", () => {
    expect(chatFloats(900, 232, 420)).toBe(true);
  });
  it("900 ohne Seitenleiste: Platz genau für MAIN_MIN → schiebt", () => {
    expect(900 - 420).toBe(MAIN_MIN);
    expect(chatFloats(900, 0, 420)).toBe(false);
  });
  it("1280 und 1728 mit Seitenleiste: schiebt wie bisher", () => {
    expect(chatFloats(1280, 232, 420)).toBe(false);
    expect(chatFloats(1728, 232, 420)).toBe(false);
  });
  it("breites Panel in 1280 mit breiter Seitenleiste: schwebt", () => {
    expect(chatFloats(1280, 480, 420)).toBe(true);
  });
  it("unter 760 px deckt das Panel das Fenster: nicht schwebend", () => {
    expect(chatFloats(700, 0, 420, true)).toBe(false);
  });
});
