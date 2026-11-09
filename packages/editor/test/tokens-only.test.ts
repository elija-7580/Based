// BSD-154 / ADR 0009: Farben im Editor kommen nur aus @based/design-tokens – kein Hex- oder rgb()-Wert.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

it("keine Farbliterale in packages/editor/src und testpage", () => {
  const offenders = [...files(join(here, "../src")), ...files(join(here, "../testpage"))]
    .filter((f) => /\.(tsx?|css)$/.test(f))
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l] as const))
    .filter(([, , l]) => /#[0-9A-Fa-f]{3,8}\b|rgba?\(/.test(l));
  expect(offenders).toEqual([]);
});
