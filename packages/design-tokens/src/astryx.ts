// Abbildung Based-Tokens → Astryx-Tokens (docs/design/astryx.md). Reine Funktion ohne Astryx-Abhängigkeit:
// apps/web/src/astryxTheme.ts reicht das Ergebnis nur an `defineTheme` weiter. Jeder Wert stammt aus tokens.json
// (direkt, als [hell, dunkel]-Paar) oder verweist auf eine CSS-Variable aus tokens.css, wo ein Schalter am
// Wurzelelement wirken soll (Stil Bold → Schriften und Titelgewicht, Schatten je Theme).
// Der Marker ist absichtlich NICHT abgebildet: er bedeutet „ein Agent hat das geschrieben“ und ist nie Akzent-,
// Button- oder Statusfarbe (docs/design/README.md, Grundsatz 2).
import { color, motion, radius, spacing, typeGroups } from "./index.js";

export type AstryxTokenValue = string | [light: string, dark: string];
export type Density = "comfortable" | "compact";

export interface AstryxThemeSpec {
  /** Theme-Name (landet als `data-astryx-theme` im DOM); je Dichte ein eigener, weil die Werte fest im Theme stehen. */
  name: string;
  tokens: Record<string, AstryxTokenValue>;
  motion: { fast: number; medium: number; ratio: number; easing: string };
  components: Record<string, Record<string, Record<string, string>>>;
}

export const ASTRYX_THEME_NAMES: Record<Density, string> = { comfortable: "based", compact: "based-compact" };

/** Farb-Token als [hell, dunkel]. */
const pair = (name: string): [string, string] => [color(name, "light"), color(name, "dark")];
/** Für zusammengesetzte Werte (Schatten, Mischungen), in denen kein Paar stehen kann. */
const ld = (name: string): string => `light-dark(${color(name, "light")}, ${color(name, "dark")})`;
const tint = (name: string, percent: number): string => `color-mix(in srgb, ${ld(name)} ${percent}%, transparent)`;

const plain = (list: { name: string; value: string }[], name: string): string => {
  const t = list.find((x) => x.name === name);
  if (!t) throw new Error(`Unknown token: ${name}`);
  return t.value;
};
const px = (value: string): number => {
  const n = parseFloat(value);
  if (!value.endsWith("px") || Number.isNaN(n)) throw new Error(`Not a px value: ${value}`);
  return n;
};
const typeStyle = (name: string) => {
  const st = typeGroups.flatMap((g) => g.styles).find((x) => x.name === name);
  if (!st) throw new Error(`Unknown type style: ${name}`);
  return st;
};

/** Astryx-Farbfamilien (Badge, Tag …) → die vier Based-Statustönungen; Text darauf ist immer Tinte. */
export const HUE_TO_STATUS: Record<string, string> = {
  blue: "status-ready", cyan: "status-ready", teal: "status-ready", purple: "status-ready",
  pink: "status-review",
  red: "status-blocked", orange: "status-blocked", yellow: "status-blocked",
  green: "status-neutral", gray: "status-neutral",
};

/** Steuerhöhen (sm, md, lg) in px: md = `space-6` wie `.btn`; Compact zieht einen Rasterschritt ab. */
export function controlHeights(density: Density): [number, number, number] {
  const step = px(plain(spacing, "space-1"));
  const md = px(plain(spacing, "space-6")) - (density === "compact" ? step : 0);
  return [md - step, md, md + step];
}

export function astryxThemeSpec(opts: { density?: Density } = {}): AstryxThemeSpec {
  const density = opts.density ?? "comfortable";
  const space = (n: number) => plain(spacing, `space-${n}`);
  const r = (name: string) => plain(radius, `radius-${name}`);
  const [sm, md, lg] = controlHeights(density);
  const ui = typeStyle("ui");
  const meta = typeStyle("meta");
  const description = typeStyle("description");
  const section = typeStyle("section");
  const heading = typeStyle("heading");
  const greeting = typeStyle("greeting");
  const body = typeStyle("body");
  const code = typeStyle("code");
  const data = typeStyle("data");

  const tokens: Record<string, AstryxTokenValue> = {
    // Flächen: canvas = Grund, bg = Seite, surface-raised = Gruppen/Karten, surface-card = Menüs
    "--color-background-body": pair("canvas"),
    "--color-background-surface": pair("bg"),
    "--color-background-card": pair("surface-raised"),
    "--color-background-popover": pair("surface-card"),
    "--color-background-muted": pair("surface-raised"),
    "--color-background-inverted": pair("ink"),
    "--color-background-error-inverted": pair("danger"),

    // Aktion = Tinte (nie der Marker)
    "--color-accent": pair("button"),
    "--color-on-accent": pair("button-ink"),
    "--color-accent-muted": pair("selected"),
    "--color-text-accent": pair("ink"),
    "--color-icon-accent": pair("ink"),
    "--color-neutral": pair("selected"),

    "--color-overlay": tint("ink", 16),
    "--color-overlay-hover": tint("ink", 6),
    "--color-overlay-pressed": tint("ink", 10),
    "--color-tint-hover": pair("ink"),

    // Text und Icons
    "--color-text-primary": pair("ink"),
    "--color-text-secondary": pair("muted"),
    "--color-text-disabled": pair("control-border"),
    "--color-icon-primary": pair("ink"),
    "--color-icon-secondary": pair("muted"),
    "--color-icon-disabled": pair("control-border"),
    "--color-on-dark": color("bg", "light"),
    "--color-on-light": color("ink", "light"),

    // Linien
    "--color-border": pair("line"),
    "--color-border-emphasized": pair("control-border"),
    "--color-skeleton": pair("selected"),
    "--color-track": pair("selected"),
    "--color-shadow": tint("ink", 10),

    // Status: Tönungen mit Tinte; nur Fehler hat eine eigene Textfarbe (danger). „synced“ trägt nie allein
    // Bedeutung und reicht als Textfarbe nicht (Kontrast), darum nur für Icon und Rand.
    "--color-info": pair("status-ready"),
    "--color-on-info": pair("ink"),
    "--color-info-muted": pair("status-ready"),
    "--color-on-info-muted": pair("ink"),
    "--color-text-info": pair("ink"),
    "--color-icon-info": pair("muted"),
    "--color-border-info": pair("control-border"),

    "--color-success": pair("status-neutral"),
    "--color-on-success": pair("ink"),
    "--color-success-muted": pair("status-neutral"),
    "--color-on-success-muted": pair("ink"),
    "--color-text-success": pair("ink"),
    "--color-icon-success": pair("synced"),
    "--color-border-success": pair("synced"),

    "--color-warning": pair("status-blocked"),
    "--color-on-warning": pair("ink"),
    "--color-warning-muted": pair("status-blocked"),
    "--color-on-warning-muted": pair("ink"),
    "--color-text-warning": pair("ink"),
    "--color-icon-warning": pair("muted"),
    "--color-border-warning": pair("control-border"),

    "--color-error": pair("danger"),
    "--color-on-error": pair("bg"),
    "--color-error-muted": pair("status-blocked"),
    "--color-on-error-muted": pair("ink"),
    "--color-text-error": pair("danger"),
    "--color-icon-error": pair("danger"),
    "--color-border-error": pair("danger"),

    // Radien: 6 (klein) · 10 (Eingaben) · 18 (Karten, Popover) · 36 (Sheets); Pille bleibt Astryx' --radius-full
    "--radius-inner": r("sm"),
    "--radius-element": r("md"),
    "--radius-container": r("xl"),
    "--radius-page": r("sheet"),
    "--radius-chat": r("xl"),

    // Abstände: beide Systeme liegen auf dem 4-px-Raster; gesetzt werden die Stufen, die es in Based gibt.
    "--spacing-1": space(1),
    "--spacing-2": space(2),
    "--spacing-3": space(3),
    "--spacing-4": space(4),
    "--spacing-6": space(5),
    "--spacing-8": space(6),
    "--spacing-10": space(7),

    "--size-element-sm": `${sm}px`,
    "--size-element-md": `${md}px`,
    "--size-element-lg": `${lg}px`,

    // Schatten wechseln mit data-theme am Wurzelelement (tokens.css)
    "--shadow-low": "var(--shadow-control)",
    "--shadow-med": "var(--shadow-float)",
    "--shadow-high": "var(--shadow-menu)",
    "--shadow-inset-hover": `inset 0 0 0 1px ${ld("control-border")}`,
    "--shadow-inset-selected": `inset 0 0 0 2px ${ld("ink")}`,
    "--shadow-inset-success": `inset 0 0 0 2px ${ld("synced")}`,
    "--shadow-inset-warning": `inset 0 0 0 2px ${ld("control-border")}`,
    "--shadow-inset-error": `inset 0 0 0 2px ${ld("danger")}`,

    "--focus-outline-color": pair("focus-ring"),

    // Schrift: Systemschrift; die Variablen folgen data-style="bold"
    "--font-family-body": "var(--font-ui)",
    "--font-family-heading": "var(--font-head)",
    "--font-family-code": "var(--font-mono)",
    "--font-size-xs": typeStyle("tab-label").fontSize,
    "--font-size-sm": meta.fontSize,
    "--font-size-base": ui.fontSize,
    "--font-size-lg": body.fontSize,
    "--font-size-xl": heading.fontSize,
    "--font-size-2xl": greeting.fontSize,
    "--font-size-3xl": typeStyle("title").fontSize,

    "--text-heading-1-size": "var(--size-title)",
    "--text-heading-1-weight": "var(--weight-title)",
    "--text-heading-1-leading": String(typeStyle("title").lineHeight),
    "--text-heading-2-size": heading.fontSize,
    "--text-heading-2-weight": "var(--weight-heading)",
    "--text-heading-2-leading": String(heading.lineHeight),
    "--text-heading-3-size": section.fontSize,
    "--text-heading-3-weight": String(section.fontWeight),
    "--text-heading-3-leading": String(section.lineHeight),
    "--text-heading-4-size": ui.fontSize,
    "--text-heading-4-weight": String(section.fontWeight),
    "--text-heading-4-leading": String(ui.lineHeight),
    "--text-heading-5-size": meta.fontSize,
    "--text-heading-5-weight": String(section.fontWeight),
    "--text-heading-5-leading": String(meta.lineHeight),
    "--text-heading-6-size": meta.fontSize,
    "--text-heading-6-weight": String(meta.fontWeight),
    "--text-heading-6-leading": String(meta.lineHeight),
    "--text-body-size": ui.fontSize,
    "--text-body-weight": String(ui.fontWeight),
    "--text-body-leading": String(ui.lineHeight),
    "--text-large-size": body.fontSize,
    "--text-large-weight": String(body.fontWeight),
    "--text-large-leading": String(body.lineHeight),
    "--text-label-size": ui.fontSize,
    "--text-label-weight": String(meta.fontWeight),
    "--text-label-leading": String(ui.lineHeight),
    "--text-supporting-size": description.fontSize,
    "--text-supporting-weight": String(description.fontWeight),
    "--text-supporting-leading": String(description.lineHeight),
    "--text-code-size": density === "compact" ? data.fontSize : code.fontSize,
    "--text-code-weight": String(code.fontWeight),
    "--text-code-leading": String(code.lineHeight),
  };

  for (const [hue, status] of Object.entries(HUE_TO_STATUS)) {
    tokens[`--color-background-${hue}`] = pair(status);
    tokens[`--color-text-${hue}`] = pair("ink");
    tokens[`--color-icon-${hue}`] = pair("ink-2");
    tokens[`--color-border-${hue}`] = pair("control-border");
  }

  const pill = r("pill");
  const group = r("xl");
  return {
    name: ASTRYX_THEME_NAMES[density],
    tokens,
    motion: { fast: parseFloat(plain(motion, "duration-fast")), medium: parseFloat(plain(motion, "duration")), ratio: 0.75, easing: plain(motion, "ease-out") },
    components: {
      // Buttons sind Pillen; primär = Tinte (kommt über --color-accent), zerstörend = danger als Text auf ruhiger Fläche
      button: {
        base: { borderRadius: pill, fontWeight: String(meta.fontWeight) },
        "variant:destructive": { backgroundColor: "var(--color-background-muted)", color: "var(--color-text-error)" },
      },
      "icon-button": { base: { borderRadius: pill } },
      badge: { base: { borderRadius: pill } },
      // Gruppen sind Flächen (Radius 18), ohne Rand
      card: { base: { borderRadius: group, padding: space(4) } },
      section: { base: { borderRadius: group, padding: space(4) } },
      dialog: { base: { borderRadius: group } },
      "alert-dialog": { base: { borderRadius: group } },
      "dropdown-menu": { base: { borderRadius: group } },
      popover: { base: { borderRadius: group } },
      "segmented-control": { base: { borderRadius: pill, padding: space(1) } },
      "segmented-control-item": {
        base: { borderRadius: pill },
        "size:sm": { height: `${sm - px(space(2))}px` },
        "size:md": { height: `${md - px(space(2))}px` },
        "size:lg": { height: `${lg - px(space(2))}px` },
      },
      // Feldnamen sind UI-Text in Tinte; grau (muted) bleibt Hinweisen vorbehalten
      "field-label": { base: { color: "var(--color-text-primary)" } },
      switch: { base: { "--color-background-gray": "var(--color-border-emphasized)" } },
    },
  };
}

/** Namen der Based-CSS-Variablen, auf die das Theme verweist (Test: es gibt sie alle in tokens.css). */
export function referencedCssVars(spec: AstryxThemeSpec): string[] {
  const values = [...Object.values(spec.tokens).flat(), ...Object.values(spec.components).flatMap((c) => Object.values(c).flatMap((s) => Object.values(s)))];
  const names = new Set<string>();
  for (const v of values) for (const m of v.matchAll(/var\((--[a-z0-9-]+)\)/g)) names.add(m[1]!);
  return [...names].sort();
}
