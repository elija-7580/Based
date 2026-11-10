import { describe, expect, it } from "vitest";
import { ASTRYX_THEME_NAMES, astryxThemeSpec, controlHeights, HUE_TO_STATUS, referencedCssVars, type AstryxTokenValue } from "../src/astryx.ts";
import { buildCss, color, colors, contrast, radius, spacing, type ThemeId } from "../src/index.ts";

const spec = astryxThemeSpec();
const themes: ThemeId[] = ["light", "dark"];
const at = (v: AstryxTokenValue | undefined, t: ThemeId): string => (Array.isArray(v) ? v[t === "light" ? 0 : 1] : (v ?? ""));
const tok = (name: string, t: ThemeId) => at(spec.tokens[name], t);

describe("Based → Astryx theme", () => {
  it.each(themes)("surfaces, text and action come from the Based tokens (%s)", (t) => {
    const map: Record<string, string> = {
      "--color-background-body": "canvas",
      "--color-background-surface": "bg",
      "--color-background-card": "surface-raised",
      "--color-background-popover": "surface-card",
      "--color-text-primary": "ink",
      "--color-text-secondary": "muted",
      "--color-accent": "button",
      "--color-on-accent": "button-ink",
      "--color-border": "line",
      "--color-border-emphasized": "control-border",
      "--color-text-error": "danger",
    };
    for (const [astryx, based] of Object.entries(map)) expect(tok(astryx, t), astryx).toBe(color(based, t));
  });

  it("never uses a marker colour", () => {
    const markers = new Set(colors.filter((c) => c.name.startsWith("marker")).flatMap((c) => [c.value.light, c.value.dark]));
    const all = JSON.stringify(spec);
    for (const m of markers) expect(all.includes(m), m).toBe(false);
    expect(all).not.toMatch(/var\(--marker/);
  });

  it("every colour literal in the theme is a Based token value", () => {
    const known = new Set(colors.flatMap((c) => [c.value.light, c.value.dark]));
    const found = JSON.stringify(spec).match(/#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)/g) ?? [];
    expect(found.length).toBeGreaterThan(50);
    for (const f of found) expect(known.has(f), f).toBe(true);
  });

  it("references only CSS variables that tokens.css or the theme itself defines", () => {
    const css = buildCss();
    for (const name of referencedCssVars(spec)) {
      expect(css.includes(`${name}:`) || name in spec.tokens || name.startsWith("--color-"), name).toBe(true);
    }
    expect(referencedCssVars(spec)).toEqual(expect.arrayContaining(["--font-ui", "--font-head", "--font-mono", "--shadow-float", "--size-title"]));
  });

  it.each(themes)("text pairs pass 4.5:1 in %s", (t) => {
    const pairs: [string, string][] = [
      ["--color-text-primary", "--color-background-surface"], ["--color-text-primary", "--color-background-body"],
      ["--color-text-primary", "--color-background-card"], ["--color-text-primary", "--color-background-popover"],
      ["--color-text-secondary", "--color-background-surface"], ["--color-text-secondary", "--color-background-body"],
      ["--color-text-secondary", "--color-background-card"], ["--color-text-secondary", "--color-background-popover"],
      ["--color-on-accent", "--color-accent"], ["--color-text-primary", "--color-neutral"], ["--color-text-primary", "--color-accent-muted"],
      ["--color-on-error", "--color-error"], ["--color-text-error", "--color-background-surface"], ["--color-text-error", "--color-background-muted"],
      ["--color-on-info", "--color-info"], ["--color-on-success", "--color-success"], ["--color-on-warning", "--color-warning"],
      ["--color-on-error-muted", "--color-error-muted"],
      ...Object.keys(HUE_TO_STATUS).map((h): [string, string] => [`--color-text-${h}`, `--color-background-${h}`]),
    ];
    for (const [fg, bg] of pairs) expect(contrast(tok(fg, t), tok(bg, t)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)("control borders and status icons pass 3:1 in %s", (t) => {
    for (const fg of ["--color-border-emphasized", "--color-icon-success", "--color-icon-error", "--color-text-disabled"]) {
      expect(contrast(tok(fg, t), tok("--color-background-surface", t)), fg).toBeGreaterThanOrEqual(3);
    }
  });

  it("radii, spacing and motion are the Based values", () => {
    const r = (n: string) => radius.find((x) => x.name === n)!.value;
    expect(spec.tokens["--radius-element"]).toBe(r("radius-md"));
    expect(spec.tokens["--radius-container"]).toBe(r("radius-xl"));
    expect(spec.components.button!.base!.borderRadius).toBe(r("radius-pill"));
    expect(spec.components.card!.base!.borderRadius).toBe(r("radius-xl"));
    // gleiches 4-px-Raster: die gesetzten Stufen ändern Astryx' Skala nicht
    for (const [k, v] of Object.entries(spec.tokens)) {
      const m = /^--spacing-(\d+)$/.exec(k);
      if (m) expect(v, k).toBe(`${Number(m[1]) * 4}px`);
    }
    expect(spec.tokens["--spacing-6"]).toBe(spacing.find((x) => x.name === "space-5")!.value);
    expect(spec.motion).toEqual({ fast: 120, medium: 180, ratio: 0.75, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  });

  it("uses the system font via the switchable Based variables, no web font", () => {
    expect(spec.tokens["--font-family-body"]).toBe("var(--font-ui)");
    expect(spec.tokens["--font-family-heading"]).toBe("var(--font-head)");
    expect(JSON.stringify(spec)).not.toMatch(/https?:|url\(|Figtree/);
    expect(spec.tokens["--text-body-size"]).toBe("14px");
    expect(spec.tokens["--text-supporting-size"]).toBe("13px");
  });

  it("compact density is its own theme with smaller controls", () => {
    const compact = astryxThemeSpec({ density: "compact" });
    expect(spec.name).toBe(ASTRYX_THEME_NAMES.comfortable);
    expect(compact.name).toBe(ASTRYX_THEME_NAMES.compact);
    expect(controlHeights("comfortable")).toEqual([28, 32, 36]);
    expect(controlHeights("compact")).toEqual([24, 28, 32]);
    expect(compact.tokens["--size-element-md"]).toBe("28px");
    expect(compact.tokens["--color-accent"]).toEqual(spec.tokens["--color-accent"]);
  });
});
