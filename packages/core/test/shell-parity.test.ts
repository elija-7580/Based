// Shell-Parität: Library (Filter, Sortierung, Duplikate), Teamspaces (anlegen, umbenennen, Icon, löschen),
// Duplizieren, Seitengraph (Aufbau, Filter, Layout) und HTML-/Druck-Export.
import { describe, expect, it } from "vitest";
import {
  MemoryPersistence, WorkspaceStore, addProperty, addRow, buildOutline, buildPageGraph, createDatabase, createPage, createTeamspace,
  deleteTeamspace, duplicatePages, exportAssetRefs, exportPageHTML, exportWorkspaceHTML, filterGraph, filterLibrary, ForceLayout,
  graphAdjacency, libraryItems, movePages, printPageHTML, pv, readZipEntries, renameTeamspace, setFavorite, setRelationTarget,
  setTeamspaceIcon, setValue, titleOf, trashPages, zipEntryData, PRIVATE_SECTION, type LibraryItem, type PageGraph,
} from "../src/index.js";

function make() {
  let now = 1000;
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "n", now: () => now });
  s.clock.wallClock = () => 9000;
  return { s, tick: (d = 10) => (now += d) };
}

const put = (s: WorkspaceStore, parent: string, type: string, text: unknown, props?: Record<string, unknown>) => {
  const id = crypto.randomUUID().toUpperCase();
  s.transact("t", (tx) => tx.put({ kind: "block", data: { id, type, parent: "b:" + parent, sk: s.endKey("b:" + parent), ...(text !== undefined ? { text } : {}), ...(props ? { props } : {}), createdAt: s.now(), updatedAt: s.now() } } as never));
  return id;
};

describe("Teamspaces", () => {
  it("anlegen mit Icon, umbenennen, Icon ändern – im Wire-Format der Swift-Records", () => {
    const { s } = make();
    const t = createTeamspace(s, "Design", "🎨");
    expect(s.workspace.teamspaces).toEqual([{ id: t, name: "Design", icon: "🎨", createdAt: 1000 }]);
    renameTeamspace(s, t, "  Design team ");
    renameTeamspace(s, t, "   "); // leer: bleibt
    expect(s.workspace.teamspaces?.[0]?.name).toBe("Design team");
    setTeamspaceIcon(s, t, undefined);
    expect("icon" in s.workspace.teamspaces![0]!).toBe(false);
    setTeamspaceIcon(s, t, "🧪");
    expect(buildOutline(s).sections).toEqual([{ id: t, name: "Design team", icon: "🧪" }, { id: PRIVATE_SECTION, name: "Private" }]);
    expect(createTeamspace(s, "")).toBeTruthy();
    expect(s.workspace.teamspaces?.[1]?.name).toBe("New teamspace");
  });

  it("löschen schickt die Seiten nach Private, in einem Undo-Schritt", () => {
    const { s } = make();
    const t = createTeamspace(s, "Team");
    const a = createPage(s, { title: "A", section: { kind: "teamspace", id: t } });
    const b = createPage(s, { title: "B" });
    movePages(s, [b], { kind: "top", section: { kind: "teamspace", id: t } });
    expect(buildOutline(s).children["section:" + t]).toEqual([a, b]);
    deleteTeamspace(s, t);
    expect(s.workspace.teamspaces).toBeUndefined();
    expect(s.blocks.get(a)?.props).toBeUndefined();
    expect(buildOutline(s).children["section:" + PRIVATE_SECTION]).toEqual([a, b]);
    s.undo();
    expect(s.workspace.teamspaces?.[0]?.id).toBe(t);
    expect(buildOutline(s).children["section:" + t]).toEqual([a, b]);
  });
});

describe("Duplizieren", () => {
  it("kopiert Seiten mit Inhalt und Unterseiten hinter das Original", () => {
    const { s } = make();
    const a = createPage(s, { title: "A" });
    const z = createPage(s, { title: "Z" });
    const text = put(s, a, "text", "hello");
    const sub = createPage(s, { parent: a, title: "Sub" });
    const [copy] = duplicatePages(s, [a, sub]); // Unterseite geht mit dem Elternteil
    expect(s.children("w")).toEqual([a, copy, z]);
    expect(titleOf(s, copy!)).toBe("A (1)");
    const kids = s.children("b:" + copy).map((k) => s.blocks.get(k)!);
    expect(kids.map((k) => [k.type, k.text])).toEqual([["text", "hello"], ["page", "Sub"]]);
    expect(kids.map((k) => k.id)).not.toContain(text);
    s.undo();
    expect(s.children("w")).toEqual([a, z]);
  });

  it("Datenbanken bekommen eigene Datenbank, Ansichten und Zeilen", () => {
    const { s } = make();
    const db = createDatabase(s, { parent: "w", title: "Tasks", sampleRows: 0 });
    const r1 = addRow(s, db.databaseID, { title: "One" })!;
    const [copy] = duplicatePages(s, [db.blockID]);
    const cb = s.blocks.get(copy!)!;
    const ndb = cb.props!.databaseID!;
    expect(ndb).not.toBe(db.databaseID);
    expect(s.databases.get(ndb)?.blockID).toBe(copy);
    const rows = s.children("d:" + ndb);
    expect(rows.length).toBe(1);
    expect(rows[0]).not.toBe(r1);
    expect(titleOf(s, rows[0]!)).toBe("One");
    const views = [...s.views.values()].filter((v) => v.blockID === copy);
    expect(views.length).toBe([...s.views.values()].filter((v) => v.blockID === db.blockID).length);
    expect(views.every((v) => v.databaseID === ndb)).toBe(true);
  });
});

describe("Library", () => {
  function sample() {
    const { s, tick } = make();
    const t = createTeamspace(s, "Team");
    const notes = createPage(s, { title: "Notes" }); tick();
    const plan = createPage(s, { title: "Plan", section: { kind: "teamspace", id: t } }); tick();
    const sub = createPage(s, { parent: plan, title: "notes " }); tick(); // gleicher Titel ohne Groß/klein und Rand
    const db = createDatabase(s, { parent: "w", title: "Tasks", sampleRows: 0 }); tick();
    const row = addRow(s, db.databaseID, { title: "Ship it" })!; tick();
    const gone = createPage(s, { title: "Gone" });
    const inGone = createPage(s, { parent: gone, title: "Inside gone" });
    trashPages(s, [gone]);
    setFavorite(s, [plan], true);
    return { s, t, notes, plan, sub, db, row, gone, inGone };
  }
  const ids = (l: LibraryItem[]) => l.map((i) => i.id);

  it("listet Seiten, Datenbanken und Zeilen ohne Papierkorb, mit Ort und Abschnitt", () => {
    const x = sample();
    const items = libraryItems(x.s);
    const by = new Map(items.map((i) => [i.id, i]));
    expect(new Set(ids(items))).toEqual(new Set([x.notes, x.plan, x.sub, x.db.blockID, x.row]));
    expect(by.get(x.notes)).toMatchObject({ kind: "page", location: "Private", section: PRIVATE_SECTION, favorite: false });
    expect(by.get(x.plan)).toMatchObject({ kind: "page", location: "Team", section: x.t, favorite: true });
    expect(by.get(x.sub)).toMatchObject({ kind: "page", location: "Plan", parentID: x.plan, section: x.t });
    expect(by.get(x.db.blockID)).toMatchObject({ kind: "database", title: "Tasks", location: "Private" });
    expect(by.get(x.row)).toMatchObject({ kind: "row", location: "Tasks", parentID: x.db.blockID });
  });

  it("filtert nach Text, Art, Teamspace, Favorit und gleichem Titel", () => {
    const x = sample();
    const items = libraryItems(x.s);
    expect(ids(filterLibrary(items, { text: " NOTE " }, "en")).sort()).toEqual([x.notes, x.sub].sort());
    expect(ids(filterLibrary(items, { text: "tasks" }, "en")).sort()).toEqual([x.db.blockID, x.row].sort()); // Ort zählt mit
    expect(ids(filterLibrary(items, { kinds: ["row"] }, "en"))).toEqual([x.row]);
    expect(ids(filterLibrary(items, { kinds: [] }, "en")).length).toBe(5);
    expect(ids(filterLibrary(items, { section: x.t, sort: "title" }, "en"))).toEqual([x.sub, x.plan]);
    expect(ids(filterLibrary(items, { section: PRIVATE_SECTION, kinds: ["page"] }, "en"))).toEqual([x.notes]);
    expect(ids(filterLibrary(items, { favoritesOnly: true }, "en"))).toEqual([x.plan]);
    expect(ids(filterLibrary(items, { onlyDuplicateTitles: true, sort: "created", ascending: true }, "en"))).toEqual([x.notes, x.sub]);
  });

  it("sortiert nach Titel, zuletzt bearbeitet und erstellt, in beide Richtungen", () => {
    const x = sample();
    const items = libraryItems(x.s);
    const titles = (q: Parameters<typeof filterLibrary>[1]) => filterLibrary(items, q, "en").map((i) => i.title);
    expect(titles({ sort: "title" }).map((t) => t.trim().toLowerCase())).toEqual(["notes", "notes", "plan", "ship it", "tasks"]);
    expect(titles({ sort: "title", ascending: false }).map((t) => t.trim().toLowerCase())).toEqual(["tasks", "ship it", "plan", "notes", "notes"]);
    expect(titles({ sort: "created", ascending: true })).toEqual(["Notes", "Plan", "notes", "Tasks", "Ship it"]);
    expect(titles({ sort: "created" })).toEqual(["Ship it", "Tasks", "notes", "Plan", "Notes"]);
    // zuletzt bearbeitet: Favorit ändert den Workspace, nicht die Seite; die Reihenfolge folgt updatedAt
    const edited = filterLibrary(items, { sort: "edited" }, "en");
    for (let i = 1; i < edited.length; i++) expect(edited[i - 1]!.edited).toBeGreaterThanOrEqual(edited[i]!.edited);
  });

  it("bleibt bei 5.000 Einträgen schnell", () => {
    const { s } = make();
    s.transact("seed", (tx) => {
      for (let i = 0; i < 5000; i++) tx.put({ kind: "block", data: { id: "P" + String(i).padStart(5, "0"), type: "page", parent: "w", sk: "a" + String(i).padStart(5, "0"), text: `Page ${i % 1000}`, createdAt: i, updatedAt: 5000 - i } } as never);
    });
    const t0 = performance.now();
    const items = libraryItems(s);
    const dup = filterLibrary(items, { onlyDuplicateTitles: true, text: "page 7", sort: "title" });
    const took = performance.now() - t0;
    expect(items.length).toBe(5000);
    expect(dup.length).toBeGreaterThan(100);
    expect(took).toBeLessThan(1500);
  });
});

describe("Seitengraph", () => {
  function sample() {
    const { s } = make();
    const t = createTeamspace(s, "Team");
    const a = createPage(s, { title: "A" });
    const b = createPage(s, { parent: a, title: "B" });
    const c = createPage(s, { title: "C", section: { kind: "teamspace", id: t } });
    const lonely = createPage(s, { title: "Lonely" });
    // Erwähnung in einem Absatz von B → C, Link-Block in einem Toggle von A → C, Based-Link im Text von C → A
    put(s, b, "text", [{ t: "see " }, { mention: { page: { _0: c } } }]);
    const toggle = put(s, a, "toggle", "more");
    put(s, toggle, "linkToPage", undefined, { linkTarget: c });
    put(s, c, "text", [{ t: "back", m: { link: "based://page/" + a } }]);
    const db = createDatabase(s, { parent: "b:" + a, title: "Tasks", sampleRows: 0 });
    const r1 = addRow(s, db.databaseID, { title: "R1" })!;
    const r2 = addRow(s, db.databaseID, { title: "R2" })!;
    const rel = addProperty(s, db.databaseID, "Blocks", "relation")!;
    setRelationTarget(s, db.databaseID, rel, db.databaseID);
    setValue(s, r1, rel, pv("relation", [r2]));
    const gone = createPage(s, { parent: a, title: "Gone" });
    put(s, gone, "text", [{ mention: { page: { _0: c } } }]);
    trashPages(s, [gone]);
    return { s, t, a, b, c, lonely, db, r1, r2, gone };
  }
  const has = (g: PageGraph, s: string, t: string, k: string) => g.edges.some((e) => e.s === s && e.t === t && e.k === k);

  it("Knoten = Seiten, Datenbanken, Zeilen; Kanten = Unterseiten, Erwähnungen/Links, Relationen", () => {
    const x = sample();
    const g = buildPageGraph(x.s);
    expect(new Set(g.nodes.map((n) => n.id))).toEqual(new Set([x.a, x.b, x.c, x.lonely, x.db.blockID, x.r1, x.r2]));
    expect(g.nodes.find((n) => n.id === x.a)).toMatchObject({ title: "A", kind: "page", top: true, section: PRIVATE_SECTION });
    expect(g.nodes.find((n) => n.id === x.c)).toMatchObject({ section: x.t, top: true });
    expect(g.nodes.find((n) => n.id === x.db.blockID)).toMatchObject({ kind: "database", top: false });
    expect(g.nodes.find((n) => n.id === x.r1)).toMatchObject({ kind: "row", title: "R1" });
    expect(has(g, x.a, x.b, "child")).toBe(true);
    expect(has(g, x.a, x.db.blockID, "child")).toBe(true);
    expect(has(g, x.db.blockID, x.r1, "child")).toBe(true);
    expect(has(g, x.b, x.c, "mention")).toBe(true);
    expect(has(g, x.a, x.c, "mention")).toBe(true); // Link-Block im Toggle gehört zur Seite A
    expect(has(g, x.c, x.a, "mention")).toBe(true);
    expect(has(g, x.r1, x.r2, "relation")).toBe(true);
    // Papierkorb: weder Knoten noch Quelle einer Kante
    expect(g.edges.some((e) => e.s === x.gone || e.t === x.gone)).toBe(false);
    // stabil sortiert
    expect(g.nodes.map((n) => n.id)).toEqual([...g.nodes.map((n) => n.id)].sort());
    expect(buildPageGraph(x.s)).toEqual(g);
  });

  it("filtert: nur verbundene, Tiefe um eine Seite, Teamspace, Kantenarten", () => {
    const x = sample();
    const g = buildPageGraph(x.s);
    const idsOf = (f: Parameters<typeof filterGraph>[1]) => new Set(filterGraph(g, f).nodes.map((n) => n.id));
    expect(idsOf({ connectedOnly: true }).has(x.lonely)).toBe(false);
    expect(idsOf({ connectedOnly: true }).size).toBe(6);
    expect(idsOf({ focus: x.r2, depth: 1 })).toEqual(new Set([x.r2, x.r1, x.db.blockID]));
    expect(idsOf({ focus: x.r2, depth: 2 })).toEqual(new Set([x.r2, x.r1, x.db.blockID, x.a]));
    expect(idsOf({ focus: x.lonely, depth: 3, connectedOnly: true })).toEqual(new Set([x.lonely]));
    expect(idsOf({ focus: "missing" }).size).toBe(7); // unbekannte Seite: kein Zuschnitt
    expect(idsOf({ section: x.t })).toEqual(new Set([x.c]));
    expect(filterGraph(g, { section: x.t }).edges).toEqual([]);
    const onlyChild = filterGraph(g, { kinds: ["child"], connectedOnly: true });
    expect(onlyChild.edges.every((e) => e.k === "child")).toBe(true);
    expect(onlyChild.nodes.some((n) => n.id === x.c)).toBe(false);
    // Kanten zeigen nie ins Leere
    for (const f of [{ focus: x.a, depth: 1 }, { section: PRIVATE_SECTION }, { connectedOnly: true }]) {
      const r = filterGraph(g, f);
      const keep = new Set(r.nodes.map((n) => n.id));
      expect(r.edges.every((e) => keep.has(e.s) && keep.has(e.t))).toBe(true);
    }
  });

  it("Layout ist deterministisch, endlich, zieht Verbundenes zusammen und behält bekannte Plätze", () => {
    const x = sample();
    const g = buildPageGraph(x.s);
    const adj = graphAdjacency(g);
    const ids = g.nodes.map((n) => n.id);
    const one = new ForceLayout(ids, adj.links);
    const two = new ForceLayout(ids, adj.links);
    one.settle();
    two.settle();
    expect(one.settled).toBe(true);
    expect([...one.x]).toEqual([...two.x]);
    expect([...one.x, ...one.y].every(Number.isFinite)).toBe(true);
    const d = (i: number, j: number) => Math.hypot(one.x[i]! - one.x[j]!, one.y[i]! - one.y[j]!);
    const i = (id: string) => adj.index.get(id)!;
    expect(d(i(x.r1), i(x.r2))).toBeLessThan(d(i(x.r1), i(x.lonely)));
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) expect(d(a, b)).toBeGreaterThan(5); // nichts übereinander
    // Neuer Knoten: die alten bleiben (fast) liegen
    const more = new ForceLayout([...ids, "ZZZ-new"], [...adj.links, [0, ids.length]], {}, one.positions());
    more.settle();
    for (let k = 0; k < ids.length; k++) expect(Math.hypot(more.x[k]! - one.x[k]!, more.y[k]! - one.y[k]!)).toBeLessThan(60);
    expect(one.nodeAt(one.x[2]! + 1, one.y[2]! - 1, 8)).toBe(2);
    expect(one.nodeAt(1e6, 1e6, 8)).toBe(-1);
  });

  it("5.000 Knoten: ein Schritt bleibt im Frame-Budget, `run` hält das Budget ein", () => {
    const n = 5000;
    const ids = Array.from({ length: n }, (_, i) => "N" + String(i).padStart(5, "0"));
    const links: [number, number][] = [];
    for (let i = 1; i < n; i++) links.push([Math.floor((i - 1) / 4), i]); // Baum mit Fächer 4
    for (let i = 0; i < 1500; i++) links.push([(i * 7919) % n, (i * 104729 + 13) % n]);
    const l = new ForceLayout(ids, links.filter(([a, b]) => a !== b));
    for (let i = 0; i < 5; i++) l.step(); // warm
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) l.step();
    const per = (performance.now() - t0) / 20;
    expect(per).toBeLessThan(150); // grob: auf belasteten CI-Maschinen bis ~70 ms; das Layout läuft ohnehin im Worker
    let clock = 0;
    const done = l.run(8, () => (clock += 3));
    expect(done).toBe(false);
    expect(l.steps).toBe(25 + 3);
    expect([...l.x].every(Number.isFinite)).toBe(true);
    l.settle(600);
    const b = l.bounds();
    expect(b.maxX - b.minX).toBeLessThan(40_000);
    // Timeout statt 5 s: settle(600) braucht allein ~4 s auf 4 Kernen; das Budget prüft `per` oben (BSD-404).
  }, 20_000);
});

describe("HTML- und Druck-Export", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  function sample() {
    const { s } = make();
    const a = createPage(s, { title: "Trip & plan" });
    put(s, a, "text", "Pack the bags & go");
    put(s, a, "image", undefined, { asset: { id: "img-1", name: "map.png", size: PNG.length, mime: "image/png" } });
    const sub = createPage(s, { parent: a, title: "Budget" });
    put(s, sub, "text", "Under 500");
    const b = createPage(s, { title: "Other" });
    put(s, b, "file", undefined, { asset: { id: "pdf-1", name: "ticket.pdf" } });
    return { s, a, sub, b };
  }
  const readAsset = (ref: { id: string }) => (ref.id === "img-1" ? PNG : ref.id === "pdf-1" ? new Uint8Array([37, 80, 68, 70]) : undefined);
  const text = (d: Uint8Array) => new TextDecoder().decode(d);

  it("eine Seite: eigenständige Datei mit eingebettetem Bild und eigenem Stylesheet", () => {
    const x = sample();
    const r = exportPageHTML(x.s, x.a, { readAsset, css: "body{color:var(--ink)}/*t*/</style><script>" });
    expect(r).toMatchObject({ name: "Trip & plan.html", kind: "html", pages: 1, assets: 1, failures: [] });
    const html = text(r.data);
    expect(html).toContain("<title>Trip &amp; plan</title>");
    expect(html).toContain("Pack the bags &amp; go");
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgoBAgM="');
    expect(html).toContain("body{color:var(--ink)}/*t*/<\\/style>"); // Stylesheet kann das Element nicht schließen
    expect(html).not.toContain("--accent"); // eingebautes CSS ersetzt
    expect(html).toContain("Budget"); // Link auf die Unterseite bleibt als Zeile
    expect(html).not.toContain("Under 500");
  });

  it("mit Unterseiten oder Ordner-Modus: ZIP mit assets/", () => {
    const x = sample();
    const r = exportPageHTML(x.s, x.a, { readAsset, subpages: true, images: "folder" });
    expect(r.kind).toBe("zip");
    expect(r.name.endsWith(".zip")).toBe(true);
    const entries = readZipEntries(r.data);
    const paths = entries.map((e) => e.path).sort();
    expect(paths.filter((p) => p.endsWith(".html")).length).toBe(2);
    expect(paths).toContain("assets/map.png");
    expect(paths.some((p) => /\/Budget\.html$/.test(p))).toBe(true);
    expect([...zipEntryData(r.data, entries.find((e) => e.path === "assets/map.png")!)]).toEqual([...PNG]);
    const page = text(zipEntryData(r.data, entries.find((e) => e.path.endsWith(".html") && !e.path.includes("/"))!));
    expect(page).toContain('src="assets/map.png"');
    expect(r).toMatchObject({ pages: 2, assets: 1, failures: [] });
    // eingebettete Bilder + Unterseiten: ZIP ohne assets/
    const e2 = exportPageHTML(x.s, x.a, { readAsset, subpages: true });
    expect(readZipEntries(e2.data).map((e) => e.path).some((p) => p.startsWith("assets/"))).toBe(false);
  });

  it("Anhänge, die sich nicht einbetten lassen, kommen als Ordner mit; Fehlendes wird gemeldet", () => {
    const x = sample();
    const r = exportPageHTML(x.s, x.b, { readAsset });
    expect(r.kind).toBe("zip");
    expect(readZipEntries(r.data).map((e) => e.path).sort()).toEqual(["Other.html", "assets/ticket.pdf"]);
    const missing = exportPageHTML(x.s, x.a, {});
    expect(missing.kind).toBe("html");
    expect(missing.failures.length).toBe(1);
    expect(missing.failures[0]!.message).toContain("map.png");
    expect(text(missing.data)).not.toContain("data:image");
    expect(() => exportPageHTML(x.s, "nope")).toThrow();
  });

  it("ganzer Workspace als ZIP; die Liste der nötigen Dateien für das Vorab-Laden", () => {
    const x = sample();
    const r = exportWorkspaceHTML(x.s, { readAsset });
    expect(r).toMatchObject({ kind: "zip", name: "Based Export HTML.zip", pages: 3, assets: 2, failures: [] });
    expect(readZipEntries(r.data).map((e) => e.path).sort()).toEqual(["Other.html", "Trip & plan.html", "Trip & plan/Budget.html", "assets/map.png", "assets/ticket.pdf"].sort());
    expect(exportAssetRefs(x.s, [x.a], false).map((a) => a.id)).toEqual(["img-1"]);
    expect(exportAssetRefs(x.s, [x.a, x.b], true).map((a) => a.id).sort()).toEqual(["img-1", "pdf-1"]);
  });

  it("Druckansicht: ein Dokument mit Druck-Regeln und eingebetteten Bildern", () => {
    const x = sample();
    const p = printPageHTML(x.s, x.a, { readAsset });
    expect(p.title).toBe("Trip & plan");
    expect(p.html).toContain("@page { margin");
    expect(p.html).toContain("break-inside: avoid");
    expect(p.html).toContain("data:image/png;base64,");
    expect(p.html).toContain("Pack the bags &amp; go");
    expect(p.failures).toEqual([]);
  });
});
