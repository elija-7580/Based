import { describe, expect, it } from "vitest";
import { GIVE_ONCE_URL, isAllowedExternal, SPONSOR_URL } from "./support.js";

describe("support links", () => {
  it("allows only the GitHub Sponsors page", () => {
    expect(isAllowedExternal(SPONSOR_URL)).toBe(true);
    expect(isAllowedExternal(GIVE_ONCE_URL)).toBe(true);
    expect(isAllowedExternal("https://github.com/sponsors/someone-else")).toBe(false);
    expect(isAllowedExternal("http://github.com/sponsors/elija-7580")).toBe(false);
    expect(isAllowedExternal("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternal("not a url")).toBe(false);
  });
});
