// BSD-10: KaTeX offline – rendert ohne Netz, Fehler kommen als Meldung zurück, Schriften liegen im Paket.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { renderTeX } from "./equation.js";

describe("renderTeX", () => {
  it("Block und inline", () => {
    const block = renderTeX("\\frac{a}{b} = \\sqrt{x^2}", true);
    expect("html" in block && block.html).toContain("katex-display");
    const inline = renderTeX("E = mc^2", false);
    expect("html" in inline && inline.html).toContain("katex");
    expect("html" in inline && inline.html).not.toContain("katex-display");
  });

  it("Fehler im TeX: Meldung statt Ausnahme", () => {
    const r = renderTeX("\\frac{a}{", true);
    expect(r).toHaveProperty("error");
    expect(renderTeX("\\unknowncommand", false)).toHaveProperty("error");
  });

  it("keine Links aus dem Ausdruck (trust: false)", () => {
    const r = renderTeX("\\href{javascript:alert(1)}{x}", false);
    expect(JSON.stringify(r)).not.toMatch(/href=/);
  });

  it("Schriften kommen aus dem Paket (relative URLs, kein CDN)", () => {
    const css = readFileSync(createRequire(import.meta.url).resolve("katex/dist/katex.min.css"), "utf8");
    const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => /^(https?:)?\/\//.test(u))).toEqual([]);
  });
});
