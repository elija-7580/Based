// BSD-461: Home ohne AI fällt auf eine vorhandene Seite zurück, statt eine leere Seite „Home“ anzulegen.
import { describe, expect, it } from "vitest";
import { fallbackHomePage, homeStaysEmpty, homeTarget, WELCOME_TITLE } from "./storage.js";

const outline = (o: { priv?: string[]; team?: string[]; kinds?: Record<string, string>; trash?: string[] }) => ({
  sections: [{ id: "t1" }, { id: "private" }],
  children: { "section:private": o.priv ?? [], "section:t1": o.team ?? [] },
  nodes: Object.fromEntries([...(o.priv ?? []), ...(o.team ?? [])].map((id) => [id, { kind: o.kinds?.[id] ?? "page" }])),
  trash: (o.trash ?? []).map((id) => ({ id })),
});

describe("fallbackHomePage (BSD-461)", () => {
  it("nimmt „Welcome to Based“ unter Private, auch wenn sie nicht oben steht", () => {
    const titles = new Map([["a", "Notes"], ["w", WELCOME_TITLE]]);
    expect(fallbackHomePage(outline({ priv: ["a", "w"] }), titles)).toBe("w");
  });
  it("sonst die erste Seite unter Private, ohne Datenbanken und Papierkorb", () => {
    const titles = new Map<string, string>();
    expect(fallbackHomePage(outline({ priv: ["db", "x", "p"], kinds: { db: "database" }, trash: ["x"] }), titles)).toBe("p");
  });
  it("sonst die erste Seite eines Teamspaces; ganz ohne Seiten undefined", () => {
    expect(fallbackHomePage(outline({ team: ["t"] }), new Map())).toBe("t");
    expect(fallbackHomePage(outline({}), new Map())).toBeUndefined();
  });
  it("eine schon gewählte Home-Seite (auch eine alte leere „Home“) bleibt", () => {
    expect(homeTarget("old-home", { has: () => true })).toEqual({ name: "page", id: "old-home" });
  });
});

describe("homeStaysEmpty (Feedback 20. 11.)", () => {
  const o = { nodes: { a: {}, t: {} }, trash: [{ id: "t" }] };
  it("frisches Gerät: Shell darf eine Seite wählen", () => {
    expect(homeStaysEmpty(undefined, { cleared: false }, o)).toBe(false);
  });
  it("„Remove as Home“: bleibt leer", () => {
    expect(homeStaysEmpty(undefined, { cleared: true }, o)).toBe(true);
  });
  it("Home-Seite im Papierkorb oder schon endgültig gelöscht: bleibt leer", () => {
    expect(homeStaysEmpty("t", { cleared: false }, o)).toBe(true);
    expect(homeStaysEmpty("gone", { cleared: false, trashedID: "gone" }, o)).toBe(true);
  });
  it("Seite, die dieser Workspace nie kannte (anderer/neuer Workspace): Shell darf wählen", () => {
    expect(homeStaysEmpty("foreign", { cleared: false }, o)).toBe(false);
  });
  it("vorhandene Seite: nicht leer", () => {
    expect(homeStaysEmpty("a", { cleared: false }, o)).toBe(false);
  });
});
