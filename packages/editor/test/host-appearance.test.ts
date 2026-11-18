import { describe, expect, it } from "vitest";
import { appearanceKey } from "../src/blocks/hostAppearance.js";

const el = (attrs: Record<string, string>, page?: Record<string, string>) => ({
  getAttribute: (n: string) => attrs[n] ?? null,
  closest: () => (page ? el(page) : null),
}) as unknown as Element;
const doc = (attrs: Record<string, string>) => ({ documentElement: el(attrs) }) as unknown as Document;

describe("appearanceKey", () => {
  it("ändert sich mit dem Stil, nicht nur mit hell/dunkel", () => {
    const base = appearanceKey(doc({ "data-theme": "light" }));
    expect(appearanceKey(doc({ "data-theme": "light", "data-style": "bold" }))).not.toBe(base);
    expect(appearanceKey(doc({ "data-theme": "dark" }))).not.toBe(base);
    expect(appearanceKey(doc({ "data-theme": "light", "data-density": "compact" }))).not.toBe(base);
  });
  it("ist nach Bold → Default wieder derselbe", () => {
    expect(appearanceKey(doc({ "data-theme": "light" }))).toBe(appearanceKey(doc({ "data-theme": "light" })));
  });
  it("ändert sich mit der Schrift der Seite", () => {
    const d = doc({ "data-theme": "light" });
    const plain = appearanceKey(d, el({}, { "data-font": "default" }));
    expect(appearanceKey(d, el({}, { "data-font": "serif" }))).not.toBe(plain);
    expect(appearanceKey(d, el({}, { "data-font": "default", "data-small-text": "" }))).not.toBe(plain);
  });
});
