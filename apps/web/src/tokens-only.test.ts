// BSD-178 / ADR 0009: Farben kommen nur aus @based/design-tokens – kein Hex- oder rgb()-Wert in apps/web/src.
// BSD-303 (docs/quality/checklist.md, Abschnitt 4): auch in packages/editor, database-ui und ui; keine freien
// Pixelwerte für Abstände, Radien und Schriftgrößen; kein `transition: all`; Dauern und Kurven nur aus Tokens;
// SVG-Icons nur aus den Icon-Dateien.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

const here = new URL(".", import.meta.url).pathname;
const repo = join(here, "../../..");
const ROOTS = [here, join(repo, "packages/editor/src"), join(repo, "packages/database-ui/src"), join(repo, "packages/ui/src")];
const sources = ROOTS.flatMap(files).filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f));
const lines = (filter: (f: string) => boolean) =>
  sources.filter(filter).flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => [relative(repo, f), i + 1, l] as const));
/** Kommentare zählen nicht (dort stehen Begründungen mit Zahlen). */
const code = (l: string) => l.replace(/\/\*.*?\*\//g, "").replace(/^\s*(\/\/|\*).*$/, "");

describe("nur Tokens", () => {
  it("keine Farbliterale", () => {
    const offenders = lines(() => true).filter(([, , l]) => /#[0-9A-Fa-f]{3,8}\b|rgba?\(/.test(code(l)));
    expect(offenders).toEqual([]);
  });

  it("keine freien Pixelwerte für Abstände, Radien und Schriftgrößen (0 und 1px-Haarlinien erlaubt, calc() aus Tokens auch)", () => {
    const prop = /(?:^|[;{\s])(border-radius|gap|row-gap|column-gap|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|font-size)\s*:\s*([^;}]*)/g;
    const offenders = lines((f) => f.endsWith(".css")).filter(([, , l]) => {
      for (const m of code(l).matchAll(prop)) {
        // Alles in Klammern (calc() aus Tokens, var()) fällt weg; übrig bleiben freie Werte.
        let value = m[2]!;
        while (/\([^()]*\)/.test(value)) value = value.replace(/\([^()]*\)/g, "");
        if (/(^|[\s(,-])([2-9]|\d{2,})(\.\d+)?px\b/.test(value)) return true;
      }
      return false;
    });
    expect(offenders).toEqual([]);
  });

  it("kein `transition: all`, Dauern und Kurven nur aus --duration*/--ease*", () => {
    const offenders = lines((f) => f.endsWith(".css")).filter(([, , l]) => {
      const c = code(l);
      if (/transition(-property)?\s*:[^;]*\ball\b/.test(c)) return true;
      const motion = /(?:transition|animation)(?:-duration|-timing-function)?\s*:\s*([^;}]*)/g;
      for (const m of c.matchAll(motion)) {
        let value = m[1]!;
        while (/\([^()]*\)/.test(value)) value = value.replace(/[a-z-]*\([^()]*\)/g, "");
        if (/\b\d+(\.\d+)?m?s\b|cubic-bezier|\bease(-in|-out|-in-out)?\b|\blinear\b/.test(value)) return true;
      }
      return false;
    });
    expect(offenders).toEqual([]);
  });

  it("SVG-Icons nur aus den Icon-Dateien", () => {
    // Ausnahmen mit Grund: die Icon-Sätze selbst; der Zeitbogen auf Home und Diagramme sind Grafiken, keine Icons;
    // @based/database-ui ist ein Paket ohne Zugriff auf apps/web und hat einen eigenen Satz auf demselben Raster;
    // ebenso @based/editor (Icons im Blockmenü und im Codeblock, `menuIcons.tsx`).
    const allowed = ["packages/editor/src/ui/menuIcons.tsx", "apps/web/src/icons.tsx", "apps/web/src/astryxIcons.tsx", "apps/web/src/home/TimeArc.tsx", "packages/database-ui/src/layouts/Chart.tsx", "packages/database-ui/src/ui.tsx"];
    const offenders = lines((f) => f.endsWith(".tsx")).filter(([f, , l]) => /<svg\b/.test(l) && !allowed.includes(f));
    expect(offenders).toEqual([]);
  });
});
