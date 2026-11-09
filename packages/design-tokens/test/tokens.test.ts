import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCss, color, colors, contrast, type ThemeId } from "../src/index.ts";

const themes: ThemeId[] = ["light", "dark"];

describe("design tokens", () => {
  it("tokens.css is generated from tokens.json", () => {
    const css = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
    expect(css).toBe(buildCss());
  });

  it("every colour has a value in both themes", () => {
    for (const c of colors) for (const t of themes) expect(c.value[t], `${c.name}/${t}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it.each(themes)("text pairs pass 4.5:1 in %s", (t) => {
    const pairs: [string, string][] = [
      ["ink", "bg"], ["ink", "sidebar"], ["ink-2", "bg"], ["muted", "bg"], ["muted", "sidebar"],
      ["button-ink", "button"], ["ink", "marker"], ["ink", "selected"], ["danger", "bg"],
      ["ink", "status-ready"], ["ink", "status-review"], ["ink", "status-blocked"],
    ];
    for (const [fg, bg] of pairs) expect(contrast(color(fg, t), color(bg, t)), `${fg} on ${bg} (${t})`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)("control borders pass 3:1 in %s", (t) => {
    expect(contrast(color("control-border", t), color("bg", t))).toBeGreaterThanOrEqual(3);
  });
});
