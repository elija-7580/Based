// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { describe, expect, it } from "vitest";
import { PAGE_TINTS, pageTint } from "./pageTint.js";

describe("pageTint", () => {
  it("bleibt für dieselbe ID gleich und liegt im Bereich", () => {
    for (const id of ["a", "page-1", "0190f3c2-7b1e-7c3a-9d2e-1f2a3b4c5d6e", ""]) {
      const t = pageTint(id);
      expect(t).toBe(pageTint(id));
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(PAGE_TINTS);
    }
  });
  it("verteilt viele IDs auf alle Farben", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) seen.add(pageTint(`0190f3c2-7b1e-7c3a-9d2e-${i.toString(16).padStart(12, "0")}`));
    expect(seen.size).toBe(PAGE_TINTS);
  });
});
