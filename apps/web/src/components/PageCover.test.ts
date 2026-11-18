// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Agent-Parität, Regel 6: Agenten benutzen dieselben Namen wie die Oberfläche. Die Cover-Farben der Oberfläche und
// die Liste im Kern (aus der `update_page` seine erlaubten Werte nimmt) dürfen nicht auseinanderlaufen.
import { describe, expect, it } from "vitest";
import { COVER_COLOR_IDS, COVER_GRADIENT_COUNT as CORE_GRADIENTS } from "@based/core";
import { COVER_COLORS, COVER_GRADIENT_COUNT } from "./PageCover.js";

describe("Cover: Oberfläche und Kern nennen dieselben Werte", () => {
  it("Farben und Zahl der Verläufe", () => {
    expect(COVER_COLORS.map((c) => c.id)).toEqual([...COVER_COLOR_IDS]);
    expect(COVER_GRADIENT_COUNT).toBe(CORE_GRADIENTS);
  });
});
