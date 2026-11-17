import { describe, expect, it } from "vitest";
import { pagePick, pickPage } from "./pagePick.js";

describe("pickPage", () => {
  it("liefert die gewählte Seite; eine neue Anfrage bricht die alte ab", async () => {
    const first = pickPage();
    const second = pickPage();
    await expect(first).resolves.toBeUndefined();
    pagePick.get()!.resolve("p1");
    await expect(second).resolves.toBe("p1");
    expect(pagePick.get()).toBeUndefined();
  });
});
