import { buildOutline, createPage, createTeamspace, MemoryPersistence, setFavorite, WorkspaceStore } from "@based/core";
import { describe, expect, it } from "vitest";
import { History, routeFromHash, routeToHash, type Route, type SavedTabs, type TabsStorage } from "./router.js";
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
    expect(rows.map((r) => (r.kind === "header" ? "#" + r.label : r.kind === "teamspace" ? "ts:" + r.name : r.kind === "page" ? r.id : "-")))
      .toEqual(["#Favorites", b, "#Teamspaces", "ts:Team", d, "#Private", a]);
    // Seiten eines Teamspaces sind unter ihm eingerückt
    expect(rows.find((r) => r.kind === "page" && r.id === d)).toMatchObject({ depth: 1 });
    expect(rows.find((r) => r.kind === "teamspace")).toMatchObject({ count: 1, collapsed: false });
  });

  it("BSD-235 Gast: ein Abschnitt „Shared with you“ ohne „+“, keine Teamspaces", () => {
    const { o, a, b, d } = outline();
    const rows = flattenSidebar(o, new Set(), new Set(), { guest: true });
    expect(rows.map((r) => (r.kind === "header" ? "#" + r.label : r.kind === "page" ? r.id : r.kind))).toEqual(["#Favorites", b, "#Shared with you", a, d]);
    const head = rows.find((r) => r.kind === "header" && r.label === "Shared with you");
    expect(head && "section" in head ? head.section : undefined).toBeUndefined();
  });

  it("aufgeklappt bis zur leeren Seite; Abschnitte zuklappbar", () => {
    const { o, a, b, c, t } = outline();
    const rows = flattenSidebar(o, new Set([a, b, c]), new Set(["favorites", t]));
    expect(rows.map((r) => r.key)).toEqual(["h/favorites", "h/teamspaces", "ts/" + t, "h/private", "s:private/" + a, `s:private/${a}/${b}`, `s:private/${a}/${b}/${c}`, `s:private/${a}/${b}/${c}/empty`]);
    expect(rowIndexOf(rows, c)).toBe(6);
    expect(ancestorsInOutline(o, c)).toEqual([a, b]);
  });

  it("ohne Teamspaces: Angebot, einen anzulegen; „Teamspaces“ und „Private“ zuklappbar", () => {
    const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "n" });
    const a = createPage(s, { title: "A" });
    const o = buildOutline(s);
    expect(flattenSidebar(o, new Set()).map((r) => r.key)).toEqual(["h/teamspaces", "a/createTeamspace", "h/private", "s:private/" + a]);
    expect(flattenSidebar(o, new Set(), new Set(["teamspaces", "private"])).map((r) => r.key)).toEqual(["h/teamspaces", "h/private"]);
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
    const rs: Route[] = [{ name: "home" }, { name: "graph" }, { name: "library" }, { name: "settings" }, { name: "trash" }, { name: "page", id: "ABC-1" }, { name: "agent", id: "run-1" }, { name: "project", id: "p-1" }];
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

  it("Tabs: eigener Verlauf je Tab, öffnen im Hintergrund, schließen, verschieben, gespeichert", () => {
    const { win, entries } = fakeWindow();
    let saved: SavedTabs | undefined;
    const storage: TabsStorage = { load: () => saved && structuredClone(saved), save: (s) => (saved = structuredClone(s)) };
    const h = new History(win, storage);
    const page = (id: string): Route => ({ name: "page", id });
    h.navigate(page("a"));
    h.navigate(page("b"));
    const first = h.activeID;

    // ⌘-Klick: neuer Tab im Hintergrund, aktiver bleibt
    const t2 = h.openTab(page("c"), { background: true });
    expect(h.activeID).toBe(first);
    expect(h.tabs.map((t) => t.route)).toEqual([page("b"), page("c")]);

    // neuer Tab vorne: eigener Verlauf
    h.activate(t2);
    expect(h.route).toEqual(page("c"));
    expect(entries.at(-1)!.hash).toBe("#page-c");
    expect(h.canBack).toBe(false);
    h.navigate(page("d"));
    h.back();
    expect(h.route).toEqual(page("c"));
    h.activate(first);
    expect(h.route).toEqual(page("b"));
    h.back();
    expect(h.route).toEqual(page("a"));

    // ⌘T, verschieben, ⌘W
    const t3 = h.openTab();
    expect(h.route).toEqual({ name: "home" });
    expect(h.tabs.map((t) => t.id)).toEqual([first, t3, t2]);
    h.move(t2, 0);
    expect(h.tabs.map((t) => t.id)).toEqual([t2, first, t3]);
    expect(h.activeID).toBe(t3);
    h.close();
    expect(h.tabs.map((t) => t.id)).toEqual([t2, first]);
    expect(h.activeID).toBe(first);

    // gespeichert: neues Fenster stellt Tabs, aktiven Tab und Verläufe wieder her
    const again = new History(fakeWindow().win, storage);
    expect(again.tabs.map((t) => t.id)).toEqual([t2, first]);
    expect(again.route).toEqual(page("a"));
    expect(again.canForward).toBe(true);
    again.forward();
    expect(again.route).toEqual(page("b"));
    again.activate(t2);
    expect(again.canForward).toBe(true);

    // ausdrücklicher Hash (Link) öffnet im aktiven Tab
    const linked = fakeWindow("#page-z");
    const third = new History(linked.win, storage);
    expect(third.route).toEqual(page("z"));
    expect(third.canBack).toBe(true);

    // letzten Tab schließen: ein leerer bleibt
    third.close(third.tabs[0]!.id);
    third.close();
    expect(third.tabs).toHaveLength(1);
    expect(third.route).toEqual({ name: "home" });
  });

  it("Browser-Zurück geht im aktiven Tab zurück", () => {
    const { win, popTo } = fakeWindow();
    const h = new History(win, undefined);
    h.navigate({ name: "page", id: "a" });
    h.navigate({ name: "page", id: "b" });
    popTo(1);
    expect(h.route).toEqual({ name: "page", id: "a" });
    popTo(2);
    expect(h.route).toEqual({ name: "page", id: "b" });
  });
});

describe("Startseite", () => {
  it("neuer Tab, App-Start und Schließen des letzten Tabs führen zur gewählten Startseite", () => {
    const start: Route = { name: "page", id: "start" };
    const h = new History(fakeWindow().win, undefined, () => start);
    expect(h.route).toEqual(start);
    h.navigate({ name: "graph" });
    h.openTab();
    expect(h.route).toEqual(start);
    h.close();
    h.close();
    expect(h.tabs).toHaveLength(1);
    expect(h.route).toEqual(start);
  });

  it("ein Link (Hash) beim Start gewinnt über die Startseite", () => {
    const h = new History(fakeWindow("#graph").win, undefined, () => ({ name: "page", id: "start" }));
    expect(h.route).toEqual({ name: "graph" });
  });
});

function fakeWindow(hash = "") {
  const entries: { state: unknown; hash: string }[] = [{ state: null, hash }];
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
  const popTo = (n: number) => {
    i = n;
    listeners.forEach((f) => f());
  };
  return { win, entries, popTo };
}

describe("Block-Links (BSD-101)", () => {
  it("#page-<id>/<block> hin und zurück; ohne Block wie bisher", async () => {
    const { routeFromHash, routeToHash } = await import("./router.js");
    expect(routeFromHash("#page-P1/B2")).toEqual({ name: "page", id: "P1", block: "B2" });
    expect(routeToHash({ name: "page", id: "P1", block: "B2" })).toBe("page-P1/B2");
    expect(routeFromHash("#page-P1")).toEqual({ name: "page", id: "P1" });
  });
});
