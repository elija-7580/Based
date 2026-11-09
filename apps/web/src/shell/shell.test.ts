import { buildOutline, createPage, createTeamspace, MemoryPersistence, setFavorite, WorkspaceStore } from "@based/core";
import { describe, expect, it } from "vitest";
import { History, routeFromHash, routeToHash, type Route } from "./router.js";
import { ancestorsInOutline, dropZone, flattenSidebar, rowIndexOf } from "./sidebarModel.js";

function outline() {
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "n" });
  const t = createTeamspace(s, "Team");
  const a = createPage(s, { title: "A" });
  const b = createPage(s, { parent: a, title: "B" });
  const c = createPage(s, { parent: b, title: "C" });
  const d = createPage(s, { section: { kind: "teamspace", id: t }, title: "D" });
  setFavorite(s, [b], true);
  return { o: buildOutline(s), a, b, c, d, t };
}

describe("Seitenleisten-Zeilen", () => {
  it("zugeklappt: Abschnitte und oberste Seiten", () => {
    const { o, a, b, d } = outline();
    const rows = flattenSidebar(o, new Set());
    expect(rows.map((r) => (r.kind === "header" ? "#" + r.label : r.kind === "page" ? r.id : "-"))).toEqual(["#Favorites", b, "#Team", d, "#Private", a]);
  });

  it("aufgeklappt bis zur leeren Seite; Abschnitte zuklappbar", () => {
    const { o, a, b, c, t } = outline();
    const rows = flattenSidebar(o, new Set([a, b, c]), new Set(["favorites", t]));
    expect(rows.map((r) => r.key)).toEqual(["h/favorites", "h/" + t, "h/private", "s:private/" + a, `s:private/${a}/${b}`, `s:private/${a}/${b}/${c}`, `s:private/${a}/${b}/${c}/empty`]);
    expect(rowIndexOf(rows, c)).toBe(5);
    expect(ancestorsInOutline(o, c)).toEqual([a, b]);
  });

  it("Ablagezonen", () => {
    expect(dropZone(2, 32, true)).toBe("before");
    expect(dropZone(16, 32, true)).toBe("inside");
    expect(dropZone(30, 32, true)).toBe("after");
    expect(dropZone(16, 32, false)).toBe("after");
  });
});

describe("Routen und Verlauf", () => {
  it("Hash hin und zurück", () => {
    const rs: Route[] = [{ name: "home" }, { name: "graph" }, { name: "settings" }, { name: "trash" }, { name: "page", id: "ABC-1" }];
    for (const r of rs) expect(routeFromHash("#" + routeToHash(r))).toEqual(r);
    expect(routeFromHash("#lecture")).toEqual({ name: "home" });
  });

  it("Vor und Zurück", () => {
    const entries: { state: unknown; hash: string }[] = [{ state: null, hash: "" }];
    let i = 0;
    const listeners: (() => void)[] = [];
    const win = {
      location: { get hash() { return entries[i]!.hash; } },
      history: {
        get state() { return entries[i]!.state; },
        replaceState: (s: unknown, _: string, h: string) => { entries[i] = { state: s, hash: h }; },
        pushState: (s: unknown, _: string, h: string) => { entries.splice(i + 1); entries.push({ state: s, hash: h }); i++; },
        back: () => { i--; listeners.forEach((f) => f()); },
        forward: () => { i++; listeners.forEach((f) => f()); },
      },
      addEventListener: (_: string, f: () => void) => listeners.push(f),
    } as unknown as Window;
    const h = new History(win);
    expect(h.canBack).toBe(false);
    h.navigate({ name: "page", id: "x" });
    h.navigate({ name: "trash" });
    expect(h.canBack).toBe(true);
    h.back();
    expect(h.route).toEqual({ name: "page", id: "x" });
    expect(h.canForward).toBe(true);
    h.forward();
    expect(h.route).toEqual({ name: "trash" });
    h.back();
    h.navigate({ name: "graph" });
    expect(h.canForward).toBe(false);
  });
});
