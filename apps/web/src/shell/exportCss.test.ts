import { color } from "@based/design-tokens";
import { describe, expect, it } from "vitest";
import { exportStylesheet } from "./exportCss.js";

describe("Export-Stylesheet aus Tokens", () => {
  const css = exportStylesheet();
  it("trägt die Token-Werte hell, dunkel und für den Druck", () => {
    expect(css).toContain(`--ink: ${color("ink", "light")};`);
    expect(css).toContain(`--ink: ${color("ink", "dark")};`);
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css.indexOf("@media print")).toBeGreaterThan(css.indexOf("prefers-color-scheme"));
    expect(css).toContain("--page-measure:");
    expect(css).toContain("--font-sans:");
    expect(css).toContain("--type-title-size:");
  });
  it("die Regeln nennen nur Variablen (keine Farbliterale) und schließen kein <style>", () => {
    const rules = css.slice(css.indexOf("html {"));
    expect(rules).not.toMatch(/#[0-9A-Fa-f]{3,8}\b|rgba?\(/);
    expect(css).not.toContain("</");
    // jede benutzte Variable ist definiert
    const used = new Set([...rules.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]!));
    for (const name of used) expect(css, name).toContain(`--${name}:`);
  });
});
