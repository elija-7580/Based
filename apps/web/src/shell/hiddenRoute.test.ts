// BSD-486: ausgeblendete Ansichten führen auf Home.
import { describe, expect, it } from "vitest";
import { hiddenRoute } from "./hiddenRoute.js";

const beta = (id: string) => !["meetings", "meeting", "graph", "coding"].includes(id);
const all = () => true;

describe("hiddenRoute (BSD-486)", () => {
  it("Beta-Build: #meetings, #graph, #coding sind ausgeblendet; Library, Seiten, Einstellungen nicht", () => {
    for (const name of ["meetings", "graph", "coding"] as const) expect(hiddenRoute({ name }, false, beta)).toBe(true);
    expect(hiddenRoute({ name: "library" }, false, beta)).toBe(false);
    expect(hiddenRoute({ name: "page", id: "p" }, false, beta)).toBe(false);
    expect(hiddenRoute({ name: "settings" }, false, beta)).toBe(false);
    expect(hiddenRoute({ name: "home" }, false, beta)).toBe(false);
  });
  it("ohne AI: #chat, #tasks, Agenten und Projekte; mit AI sichtbar", () => {
    for (const r of [{ name: "chat" }, { name: "tasks" }, { name: "agent", id: "a" }, { name: "project", id: "p" }] as const) {
      expect(hiddenRoute(r, false, all)).toBe(true);
      expect(hiddenRoute(r, true, all)).toBe(false);
    }
    expect(hiddenRoute({ name: "graph" }, false, all)).toBe(false);
  });
});
