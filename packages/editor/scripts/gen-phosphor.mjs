// BSD-376: erzeugt src/ui/phosphor-data.ts aus @phosphor-icons/core (MIT, Stil „fill“) – offline gebündelt,
// nur Pfaddaten + Suchwörter. Neu erzeugen nach einem Versionssprung: `node packages/editor/scripts/gen-phosphor.mjs`.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../node_modules/@phosphor-icons/core", import.meta.url));
const { icons } = await import(join(root, "dist/index.mjs"));
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const rows = [];
for (const icon of icons) {
  const svg = readFileSync(join(root, "assets/fill", `${icon.name}-fill.svg`), "utf8");
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  if (/<(?!\/?(path|circle|rect|line|polyline|polygon|ellipse)\b)/.test(inner)) throw new Error(`unexpected markup in ${icon.name}`);
  const words = [...new Set([icon.name.replace(/-/g, " "), ...icon.tags.filter((t) => !t.startsWith("*")), ...icon.categories])].join(" ").toLowerCase();
  rows.push([icon.name, words, inner]);
}
rows.sort((a, b) => a[0].localeCompare(b[0]));
const out = `// Erzeugt von scripts/gen-phosphor.mjs aus @phosphor-icons/core ${version} (MIT, © Phosphor Icons) – nicht von Hand ändern.
// [Name, Suchwörter, SVG-Inhalt (viewBox 0 0 256 256, fill)]
export const PHOSPHOR_VERSION = ${JSON.stringify(version)};
export const PHOSPHOR_ICONS: ReadonlyArray<readonly [string, string, string]> = ${JSON.stringify(rows)};
`;
writeFileSync(new URL("../src/ui/phosphor-data.ts", import.meta.url), out);
console.log(`${rows.length} icons, ${(out.length / 1024).toFixed(0)} kB`);
