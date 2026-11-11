// BSD-90 Teil 2: „[[Titel]]“ beim Tippen erkennen (das zweite „]“ löst aus).
import { describe, expect, it } from "vitest";
import { wikilinkBefore } from "../src/ui/mentions.js";

describe("[[Wikilinks]] beim Tippen", () => {
  it("erkennt [[Titel] am Ende, nicht ohne Titel, nicht über Klammern hinweg", () => {
    expect(wikilinkBefore("See [[Launch plan]")).toBe("Launch plan");
    expect(wikilinkBefore("[[ Spaces ]")).toBe("Spaces");
    expect(wikilinkBefore("[[]")).toBeUndefined();
    expect(wikilinkBefore("[[a]b]")).toBeUndefined();
    expect(wikilinkBefore("plain text]")).toBeUndefined();
    expect(wikilinkBefore("[[Done]] and more]")).toBeUndefined();
  });
});
