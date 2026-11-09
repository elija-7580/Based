// Based Default design language (ADR 0012). tokens.json is the single source;
// tokens.css is generated from it with `pnpm --filter @based/design-tokens css`.
import tokens from "../tokens.json" with { type: "json" };

export type ThemeId = "light" | "dark";
export type Marker = "butter" | "mint" | "sky" | "rose";

interface ColorToken { name: string; value: Record<ThemeId, string>; usage: string }
interface PlainToken { name: string; value: string; usage: string }
interface ShadowToken { name: string; value: Record<ThemeId, string>; usage: string }
interface TypeStyle {
  name: string; fontSize: string; lineHeight: number; fontWeight: number;
  letterSpacing?: string; family?: string; usage: string; sample: string;
}

export const colors = tokens.color.tokens as ColorToken[];
export const spacing = tokens.spacing.tokens as PlainToken[];
export const radius = tokens.radius.tokens as PlainToken[];
export const shadows = tokens.shadow.tokens as ShadowToken[];
export const motion = tokens.motion.tokens as PlainToken[];
export const families = tokens.type.families as Record<"sans" | "mono" | "bold-sans" | "bold-serif", string>;
export const typeGroups = tokens.type.groups as { name: string; family: string; styles: TypeStyle[] }[];

export function color(name: string, theme: ThemeId = "light"): string {
  const token = colors.find((c) => c.name === name);
  if (!token) throw new Error(`Unknown color token: ${name}`);
  return token.value[theme];
}

const block = (selector: string, vars: [string, string][]): string =>
  `${selector} {\n${vars.map(([k, v]) => `  --${k}: ${v};`).join("\n")}\n}\n`;

/** The whole stylesheet. Switches live on the root element:
 *  data-theme="light|dark", data-style="bold", data-density="compact",
 *  data-marker="mint|sky|rose", data-calm. */
export function buildCss(): string {
  const themed = (theme: ThemeId): [string, string][] => [
    ...colors.map((c): [string, string] => [c.name, c.value[theme]]),
    ...shadows.map((s): [string, string] => [s.name, s.value[theme]]),
  ];
  const plain: [string, string][] = [
    ...spacing.map((t): [string, string] => [t.name, t.value]),
    ...radius.map((t): [string, string] => [t.name, t.value]),
    ...motion.map((t): [string, string] => [t.name, t.value]),
    ["font-sans", families.sans],
    ["font-mono", families.mono],
    // Semantic type roles, switched by data-style and data-density.
    ["font-ui", "var(--font-sans)"],
    ["font-head", "var(--font-sans)"],
    ["font-body", "var(--font-sans)"],
    ["size-title", "32px"], ["weight-title", "650"], ["tracking-title", "-0.015em"],
    ["size-greeting", "28px"], ["weight-heading", "600"],
    ["size-body", "16px"], ["leading-body", "1.68"],
    ["row-pad", "10px"], ["cell-pad", "8px"],
  ];
  const bold: [string, string][] = [
    ["font-ui", families["bold-sans"]], ["font-head", families["bold-sans"]], ["font-body", families["bold-serif"]],
    ["size-title", "40px"], ["weight-title", "800"], ["tracking-title", "-0.035em"],
    ["size-greeting", "36px"], ["weight-heading", "700"],
    ["size-body", "17px"], ["leading-body", "1.7"],
  ];
  const compact: [string, string][] = [["size-body", "14.5px"], ["leading-body", "1.5"], ["row-pad", "7px"], ["cell-pad", "5px"]];
  const markers: Marker[] = ["mint", "sky", "rose"];
  return [
    "/* Based — generated from tokens.json. Do not edit; run `pnpm --filter @based/design-tokens css`. */\n",
    block(':root,\n[data-theme="light"]', themed("light")),
    block('[data-theme="dark"]', themed("dark")),
    block(":root", plain),
    block('[data-style="bold"]', bold),
    block('[data-density="compact"]', compact),
    ...markers.map((m) => block(`[data-marker="${m}"]`, [["marker", `var(--marker-${m})`], ["marker-strong", `var(--marker-${m}-strong)`]])),
    block("[data-calm]", [["marker", "var(--marker-calm)"], ["marker-strong", "var(--marker-calm)"]]),
  ].join("\n");
}

/** WCAG relative-luminance contrast of two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
