import { describe, expect, it } from "vitest";
import { atQuery, filterCommands, nextMode, removeAt, slashQuery } from "./composer.js";

describe("Coding-Eingabe (BSD-313)", () => {
  it("Slash nur am Anfang und solange der Name getippt wird", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/review now")).toBeUndefined();
    expect(slashQuery("a /x")).toBeUndefined();
  });
  it("Befehle: Anfang vor Enthalten, Beschreibung zählt mit", () => {
    const cmds = [{ name: "init", description: "Create AGENTS.md" }, { name: "review", description: "Review changes" }, { name: "preview", description: "x" }];
    expect(filterCommands(cmds, "rev").map((c) => c.name)).toEqual(["review", "preview"]);
    expect(filterCommands(cmds, "agents").map((c) => c.name)).toEqual(["init"]);
    expect(filterCommands(cmds, "").length).toBe(3);
  });
  it("@ vor dem Cursor, nicht mitten in einer Mail-Adresse", () => {
    expect(atQuery("look at @src/ma", 15)).toEqual({ start: 8, query: "src/ma" });
    expect(atQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(atQuery("mail a@b.de", 11)).toBeUndefined();
    expect(atQuery("@a b", 4)).toBeUndefined();
    expect(removeAt("look at @src/ma please", { start: 8, query: "src/ma" })).toEqual({ text: "look at  please", caret: 8 });
  });
  it("⇧Tab: nächster Modus, am Ende wieder vorn", () => {
    const modes = [{ id: "default" }, { id: "acceptEdits" }, { id: "plan" }];
    expect(nextMode(modes, "default")).toBe("acceptEdits");
    expect(nextMode(modes, "plan")).toBe("default");
    expect(nextMode(modes, undefined)).toBe("default");
    expect(nextMode([], "x")).toBeUndefined();
  });
});
