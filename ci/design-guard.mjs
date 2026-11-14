#!/usr/bin/env node
// BSD-348: Design-Wächter (docs/design/astryx.md → Regeln, Skill .claude/skills/based-design). Prüft im TS-Stack:
//   button  – kein JSX <button> in Oberflächen (BasedButton aus @based/ui/astryx nehmen)
//   astryx  – kein Import von @astryxdesign/core* außerhalb packages/ui, apps/web/src/main.tsx, apps/web/src/astryxTheme.ts
//   px      – keine festen px in CSS außer 0, 1 und 3 px (Tokens aus tokens.css nehmen)
// Bestand steht in ci/design-allowlist.json (je Datei und Regel eine Höchstzahl) und darf nur schrumpfen:
//   node ci/design-guard.mjs            prüfen (rot bei jedem neuen Verstoß; Hinweis, wo die Liste kleiner werden kann)
//   node ci/design-guard.mjs --shrink   Liste auf den Ist-Stand verkleinern (erhöht nie etwas)
//   node ci/design-guard.mjs --rebaseline  Liste auf den Ist-Stand setzen (nur beim ersten Einführen bzw. auf Anweisung;
//                                       die CI prüft mit --base, dass sie gegenüber main nicht wächst)
//   --base <git-ref>                    zusätzlich rot, wenn die Liste gegenüber <ref> gewachsen ist (CI: origin/main)
// packages/ui (die Bausteine selbst) zählt nur für px.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const LIST = join(ROOT, "ci/design-allowlist.json");
const SCOPES = ["apps/web/src", "apps/desktop/src", "packages/editor/src", "packages/database-ui/src", "packages/ui/src"];
const ASTRYX_OK = new Set(["apps/web/src/main.tsx", "apps/web/src/astryxTheme.ts"]);
const isTest = (p) => /\.(test|spec)\.tsx?$/.test(p) || p.includes("/e2e/");

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * Kommentare entfernen, damit Hinweise wie „kein <button>“ nicht zählen. CSS: Regex genügt (keine Strings mit „/*“
 * im Bestand). TS/TSX (BSD-412): mit dem TypeScript-Parser neu ausgeben, ohne Kommentare – ein „/*“ in einem String
 * oder Regex (`accept="image/*"`) öffnete mit der Regex einen Kommentar bis zum nächsten echten „*\/“.
 */
const stripCSSComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const printer = ts.createPrinter({ removeComments: true });
export function stripTSComments(src, file = "x.tsx") {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return printer.printFile(ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, kind));
}

export function scan(root = ROOT) {
  const counts = {};
  const add = (file, rule, n) => { if (n > 0) (counts[file] ??= {})[rule] = n; };
  for (const scope of SCOPES) {
    for (const abs of walk(join(root, scope))) {
      const file = relative(root, abs).split(sep).join("/");
      if (isTest(file)) continue;
      if (/\.tsx?$/.test(file)) {
        const src = stripTSComments(readFileSync(abs, "utf8"), file);
        if (file.endsWith(".tsx") && !file.startsWith("packages/ui/")) add(file, "button", (src.match(/<button\b/g) ?? []).length);
        if (!file.startsWith("packages/ui/") && !ASTRYX_OK.has(file)) add(file, "astryx", (src.match(/(?:from\s*|import\s*\(\s*|import\s+)["']@astryxdesign\/core[^"']*["']/g) ?? []).length);
      } else if (file.endsWith(".css")) {
        const src = stripCSSComments(readFileSync(abs, "utf8"));
        const px = [...src.matchAll(/(?<![\w.-])(\d*\.?\d+)px\b/g)].filter((m) => !["0", "1", "3"].includes(String(Number(m[1]))));
        add(file, "px", px.length);
      }
    }
  }
  return counts;
}

function compare(actual, allowed) {
  const errors = [], shrink = [];
  for (const [file, rules] of Object.entries(actual)) {
    for (const [rule, n] of Object.entries(rules)) {
      const max = allowed[file]?.[rule] ?? 0;
      if (n > max) errors.push(`${file}: ${n} × ${rule} (erlaubt ${max})`);
      else if (n < max) shrink.push(`${file}: ${rule} ${max} → ${n}`);
    }
  }
  for (const [file, rules] of Object.entries(allowed)) {
    for (const [rule, max] of Object.entries(rules)) if (!(actual[file]?.[rule]) && max > 0) shrink.push(`${file}: ${rule} ${max} → 0`);
  }
  return { errors, shrink };
}

const totals = (c) => Object.values(c).reduce((t, r) => { for (const [k, v] of Object.entries(r)) t[k] = (t[k] ?? 0) + v; return t; }, {});

if (import.meta.url === `file://${process.argv[1]}`) {
  const actual = scan();
  const allowed = JSON.parse(readFileSync(LIST, "utf8")).files;
  if (process.argv.includes("--rebaseline")) {
    const files = Object.fromEntries(Object.entries(actual).sort());
    writeFileSync(LIST, JSON.stringify({ note: "BSD-348: Bestand, darf nur schrumpfen (node ci/design-guard.mjs --shrink)", totals: totals(files), files }, null, 2) + "\n");
    console.log("design-guard: Liste neu gesetzt", JSON.stringify(totals(files)));
    process.exit(0);
  }
  if (process.argv.includes("--shrink")) {
    const next = {};
    for (const [file, rules] of Object.entries(allowed)) {
      for (const [rule, max] of Object.entries(rules)) {
        const n = Math.min(max, actual[file]?.[rule] ?? 0);
        if (n > 0) (next[file] ??= {})[rule] = n;
      }
    }
    writeFileSync(LIST, JSON.stringify({ note: "BSD-348: Bestand, darf nur schrumpfen (node ci/design-guard.mjs --shrink)", totals: totals(next), files: next }, null, 2) + "\n");
    console.log("design-guard: Liste verkleinert", JSON.stringify(totals(next)));
    process.exit(0);
  }
  const { errors, shrink } = compare(actual, allowed);
  const bi = process.argv.indexOf("--base");
  if (bi > 0 && process.argv[bi + 1]) {
    let base;
    try { base = JSON.parse(execFileSync("git", ["show", `${process.argv[bi + 1]}:ci/design-allowlist.json`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).files; } catch { base = undefined; }
    // BSD-412: Ändert sich die Zählweise (dieses Skript) gegenüber der Basis, darf die Liste einmal auf den echten
    // Stand steigen – aber nur bis zur tatsächlichen Zahl, nie darüber.
    let guardChanged = false;
    try { guardChanged = execFileSync("git", ["diff", "--name-only", process.argv[bi + 1], "--", "ci/design-guard.mjs"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== ""; } catch { guardChanged = false; }
    if (base) {
      for (const [file, rules] of Object.entries(allowed)) {
        for (const [rule, max] of Object.entries(rules)) {
          const before = base[file]?.[rule] ?? 0;
          if (max <= before) continue;
          if (guardChanged && max <= (actual[file]?.[rule] ?? 0)) console.log(`design-guard: Zählweise geändert – ${file} ${rule} ${before} → ${max} (echter Stand)`);
          else errors.push(`ci/design-allowlist.json: ${file} ${rule} ${before} → ${max} (die Liste darf nur schrumpfen)`);
        }
      }
    }
  }
  if (shrink.length) console.log(`design-guard: ${shrink.length} Stelle(n) besser als die Liste – mit --shrink festhalten.`);
  if (errors.length) {
    console.error("design-guard: neue Verstöße gegen die Design-Regeln (docs/design/astryx.md):\n  " + errors.join("\n  "));
    console.error("Statt <button> → BasedButton, statt @astryxdesign/core → @based/ui/astryx, statt px → var(--…) aus tokens.css.");
    process.exit(1);
  }
  console.log("design-guard OK", JSON.stringify(totals(actual)));
}
