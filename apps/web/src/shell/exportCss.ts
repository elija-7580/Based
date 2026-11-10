// Stylesheet für exportierte HTML-Seiten und die Druckansicht, erzeugt aus den Design-Tokens (ADR 0009): Farben hell
// und – über `prefers-color-scheme` – dunkel, Schrift, Abstände, Radien. Die Regeln selbst nennen nur Variablen; der
// Export ist damit eigenständig (keine Datei der App nötig) und sieht aus wie „Based Default“. Im Druck gilt immer Hell.
import { colors, families, radius, spacing, typeGroups } from "@based/design-tokens";

const vars = (pairs: [string, string][]) => pairs.map(([k, v]) => `--${k}: ${v};`).join(" ");

function typeVars(): [string, string][] {
  const out: [string, string][] = [];
  for (const g of typeGroups) {
    if (g.name.startsWith("Bold")) continue;
    for (const st of g.styles) out.push([`type-${st.name}-size`, st.fontSize], [`type-${st.name}-leading`, String(st.lineHeight)], [`type-${st.name}-weight`, String(st.fontWeight)]);
  }
  return out;
}

const RULES = `
html { background: var(--bg); color: var(--ink-2); }
body { margin: 0; font-family: var(--font-sans); font-size: var(--type-body-size); line-height: var(--type-body-leading); -webkit-text-size-adjust: 100%; }
.page { max-width: var(--page-measure); margin: 0 auto; padding: var(--space-8) var(--space-5) calc(var(--space-8) * 2); }
.icon { font-size: var(--space-8); line-height: 1; margin-bottom: var(--space-2); }
h1.title { font-size: var(--type-title-size); line-height: var(--type-title-leading); font-weight: var(--type-title-weight); color: var(--ink); margin: 0 0 var(--space-5); }
h2, h3, h4, h5 { color: var(--ink); font-weight: var(--type-heading-weight); line-height: var(--type-heading-leading); }
h2 { font-size: 1.6em; margin: 1.4em 0 .3em; } h3 { font-size: 1.3em; margin: 1.2em 0 .2em; }
h4 { font-size: 1.12em; margin: 1em 0 .2em; } h5 { font-size: 1em; margin: 1em 0 .2em; }
p { margin: var(--space-1) 0; min-height: 1.6em; }
.indent { padding-left: 1.6em; }
a { color: inherit; text-decoration: underline; text-decoration-color: var(--muted); text-underline-offset: .18em; }
code { font-family: var(--font-mono); font-size: .86em; background: var(--surface-raised); color: var(--ink); padding: .1em .35em; border-radius: var(--radius-xs); }
pre { background: var(--surface-raised); padding: var(--space-4); border-radius: var(--radius-sm); overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { border-left: var(--space-1) solid var(--line); margin: var(--space-2) 0; padding: 0 var(--space-4); color: var(--ink-2); }
hr { border: 0; border-top: 1px solid var(--line); margin: var(--space-4) 0; }
ul, ol { margin: var(--space-1) 0; padding-left: 1.6em; } ul.todo { list-style: none; padding-left: .2em; }
ul.todo li.checked > span { text-decoration: line-through; color: var(--muted); }
details { margin: var(--space-1) 0; } details > summary { cursor: pointer; }
details > summary h2, details > summary h3, details > summary h4, details > summary h5 { display: inline; }
.callout { display: flex; gap: var(--space-3); background: var(--surface-raised); border-radius: var(--radius-lg); padding: var(--space-4); margin: var(--space-2) 0; }
.callout-icon { font-size: 1.3em; line-height: 1.2; }
figure { margin: var(--space-2) 0; } img, video { max-width: 100%; border-radius: var(--radius-sm); }
figcaption, .caption { color: var(--muted); font-size: var(--type-description-size); }
iframe.embed { width: 100%; height: 420px; border: 1px solid var(--line); border-radius: var(--radius-sm); }
.html-block iframe { width: 100%; min-height: 320px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: transparent; }
.bookmark { display: flex; flex-direction: column; background: var(--surface-raised); border-radius: var(--radius-lg); padding: var(--space-3) var(--space-4); margin: var(--space-2) 0; text-decoration: none; }
.bookmark-title { font-weight: var(--type-heading-weight); color: var(--ink); } .bookmark-desc, .bookmark-url { color: var(--muted); font-size: var(--type-description-size); }
.page-link a { text-decoration: none; border-bottom: 1px solid var(--line); color: var(--ink); }
.mention { color: var(--muted); }
table { border-collapse: collapse; margin: var(--space-2) 0; width: 100%; font-size: var(--type-ui-size); }
th, td { border-bottom: 1px solid var(--line); padding: var(--space-2); text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: var(--type-meta-weight); }
table.properties { width: auto; margin-bottom: var(--space-5); } table.properties th, table.properties td { border: 0; padding: var(--space-1) var(--space-3) var(--space-1) 0; }
.db-title { margin-top: 1.4em; }
.columns { display: flex; gap: var(--space-5); } .column { flex: 1; min-width: 0; }
.equation { text-align: center; margin: var(--space-2) 0; overflow-x: auto; font-family: var(--font-mono); } .equation.inline { display: inline; }
.color-gray, .color-brown { color: var(--muted); }
.color-red, .color-pink, .color-orange { color: var(--danger); }
.color-green { color: var(--synced); }
.color-grayBackground, .color-yellowBackground, .color-greenBackground { background: var(--status-neutral); }
.color-redBackground, .color-pinkBackground { background: var(--status-review); }
.color-orangeBackground, .color-brownBackground { background: var(--status-blocked); }
.color-blueBackground, .color-purpleBackground { background: var(--status-ready); }
[class*="Background"] { border-radius: var(--radius-xs); }
`;

let cached: string | undefined;

/** Das Stylesheet für HTML-Export und Druck (einmal je Sitzung gebaut). */
export function exportStylesheet(): string {
  if (cached) return cached;
  const themed = (theme: "light" | "dark") => colors.map((c): [string, string] => [c.name, c.value[theme]]);
  const plain: [string, string][] = [
    ...spacing.map((t): [string, string] => [t.name, t.value]),
    ...radius.map((t): [string, string] => [t.name, t.value]),
    ["font-sans", families.sans],
    ["font-mono", families.mono],
    ...typeVars(),
  ];
  cached = [
    `:root { color-scheme: light dark; ${vars(themed("light"))} ${vars(plain)} }`,
    `@media (prefers-color-scheme: dark) { :root { ${vars(themed("dark"))} } }`,
    `@media print { :root { color-scheme: light; ${vars(themed("light"))} } }`,
    RULES.trim(),
  ].join("\n");
  return cached;
}
