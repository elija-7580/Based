// BSD-178 / ADR 0009: Farben kommen nur aus @based/design-tokens – kein Hex- oder rgb()-Wert in apps/web/src.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));

it("keine Farbliterale in apps/web/src", () => {
  const offenders = files(new URL(".", import.meta.url).pathname)
    .filter((f) => /\.(tsx?|css)$/.test(f) && !f.endsWith(".test.ts"))
    .flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l] as const))
    .filter(([, , l]) => /#[0-9A-Fa-f]{3,8}\b|rgba?\(/.test(l));
  expect(offenders).toEqual([]);
});
