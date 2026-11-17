import { describe, expect, it } from "vitest";
import { markFreshPage, takeFreshPage } from "./freshPage.js";

describe("freshPage (BSD-482)", () => {
  it("gibt eine vorgemerkte Seite genau einmal her, andere nie", () => {
    markFreshPage("a");
    expect(takeFreshPage("b")).toBe(false);
    expect(takeFreshPage("a")).toBe(true);
    expect(takeFreshPage("a")).toBe(false);
  });
  it("die zuletzt angelegte Seite gewinnt", () => {
    markFreshPage("a");
    markFreshPage("b");
    expect(takeFreshPage("a")).toBe(false);
    expect(takeFreshPage("b")).toBe(true);
  });
});
