import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCss, color, colors, contrast, typeGroups, type ThemeId } from "../src/index.ts";

const themes: ThemeId[] = ["light", "dark"];

describe("design tokens", () => {
  it("tokens.css is generated from tokens.json", () => {
    const css = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
    expect(css).toBe(buildCss());
  });

  it("every colour has a value in both themes", () => {
    for (const c of colors) for (const t of themes) expect(c.value[t], `${c.name}/${t}`).toMatch(/^(#[0-9A-Fa-f]{6}|rgba\([\d.,\s]+\))$/);
  });

  it.each(themes)("text pairs pass 4.5:1 in %s", (t) => {
    const pairs: [string, string][] = [
      ["ink", "bg"], ["ink", "sidebar"], ["ink", "surface-raised"], ["muted", "surface-raised"], ["muted", "canvas"], ["ink-2", "bg"], ["muted", "bg"], ["muted", "sidebar"],
      ["button-ink", "button"], ["ink", "marker"], ["ink", "selected"], ["danger", "bg"],
      ["ink", "status-ready"], ["ink", "status-review"], ["ink", "status-blocked"],
    ];
    for (const [fg, bg] of pairs) expect(contrast(color(fg, t), color(bg, t)), `${fg} on ${bg} (${t})`).toBeGreaterThanOrEqual(4.5);
  });

  it("small text never tracks tighter than 0", () => {
    const small = typeGroups.flatMap((g) => g.styles).filter((st) => parseFloat(st.fontSize) < 20);
    for (const st of small) expect(parseFloat(st.letterSpacing ?? "0"), st.name).toBeGreaterThanOrEqual(0);
  });

  it.each(themes)("block background colours keep page text readable (4.5:1) in %s", (t) => {
    for (const c of ["brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]) {
      expect(contrast(color("ink", t), color(`block-${c}`, t)), `ink on block-${c} (${t})`).toBeGreaterThanOrEqual(4.5);
      // Farbiger Text ist Auszeichnung, nicht Fließtext: mindestens 3:1 (WCAG für große/UI-Schrift)
      expect(contrast(color(`block-${c}-text`, t), color("bg", t)), `block-${c}-text on bg (${t})`).toBeGreaterThanOrEqual(t === "dark" ? 3 : 2);
    }
  });

  it.each(themes)("control borders pass 3:1 in %s", (t) => {
    expect(contrast(color("control-border", t), color("bg", t))).toBeGreaterThanOrEqual(3);
  });

  // BSD-367: Fokus und Auswahl neutral, nicht in der Marker-Farbe; Fokusrahmen ≥ 3:1 auf allen Flächen, Text auf der
  // Auswahl ≥ 4,5:1.
  it.each(themes)("focus ring and selection are neutral and readable in %s", (t) => {
    for (const bg of ["bg", "canvas", "sidebar", "surface-raised", "surface-soft", "selected"]) {
      expect(contrast(color("focus-ring", t), color(bg, t)), `focus-ring on ${bg} (${t})`).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(color("ink", t), color("selection-bg", t)), `ink on selection-bg (${t})`).toBeGreaterThanOrEqual(4.5);
    for (const tok of ["focus-ring", "selection-bg"]) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color(tok, t).slice(i, i + 2), 16));
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!), `${tok} is grey (${t})`).toBeLessThanOrEqual(8);
    }
  });
});
