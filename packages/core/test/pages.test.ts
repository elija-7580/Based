// BSD-153: Seitenverwaltung (Seitenleiste, Papierkorb, Favoriten) und Seitenleisten-Struktur.
import { describe, expect, it } from "vitest";
import {
  MemoryPersistence, WorkspaceStore, buildOutline, createPage, createTeamspace, deleteForever, dropPages, emptyTrash, keyOf,
  movePages, pageAncestors, pageTitles, renamePage, restorePages, sectionKey, setFavorite, trashPages, trashedPages, type WireRecord,
} from "../src/index.js";

const blk = (id: string, parent: string, sk: string, type = "page", extra: Record<string, unknown> = {}): WireRecord => ({
  kind: "block",
  data: { id, type, parent, sk, text: id, createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "x" }, ...extra },
});

function make(records: WireRecord[] = []) {
  const p = new MemoryPersistence(records);
  let now = 1000;
  const s = new WorkspaceStore({ persistence: p, node: "n", now: () => now });
  s.clock.wallClock = () => 9000;
  return { s, p, tick: (d: number) => (now += d) };
}

describe("Seiten", () => {
  it("legt Seiten oben, in Teamspaces und als Unterseite an", () => {
    const { s } = make();
    const a = createPage(s, { title: "A" });
    const b = createPage(s, { title: "B" });
    const t = createTeamspace(s, "Team");
    const c = createPage(s, { title: "C", section: { kind: "teamspace", id: t } });
    const d = createPage(s, { parent: a, title: "D" });
    expect(s.children("w")).toEqual([a, b, c]);
    expect(s.blocks.get(c)?.props?.teamspace).toBe(t);
    const o = buildOutline(s);
    expect(o.sections.map((x) => x.name)).toEqual(["Team", "Private"]);
    expect(o.children[sectionKey("private")]).toEqual([a, b]);
    expect(o.children[sectionKey(t)]).toEqual([c]);
    expect(o.children[a]).toEqual([d]);
    expect(o.nodes[d]?.parent).toBe(a);
    s.undo();
    expect(s.blocks.has(d)).toBe(false);
  });

  it("benennt Seiten und Datenbanken um (Tippen zusammengefasst)", () => {
    const { s } = make([
      blk("p", "w", "a0"),
      blk("dbp", "w", "a1", "databasePage", { props: { databaseID: "db" } }),
      { kind: "database", data: { id: "db", blockID: "dbp", title: "Old", properties: [], createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "x" } } },
    ]);
    renamePage(s, "p", "N");
    renamePage(s, "p", "Ne");
    renamePage(s, "p", "New");
    renamePage(s, "dbp", "Tasks");
    expect(pageTitles(s)).toEqual({ p: "New", dbp: "Tasks" });
    s.undo();
    s.undo();
    expect(s.blocks.get("p")?.text).toBe("p");
  });

  it("Papierkorb: verstecken, wiederherstellen, verwaiste nach oben, endgültig löschen", () => {
    const { s, p, tick } = make([blk("a", "w", "a0"), blk("b", "b:a", "a0"), blk("t", "b:b", "a0", "text")]);
    setFavorite(s, ["b"], true);
    expect(trashPages(s, ["a", "b"])).toEqual(["a"]);
    let o = buildOutline(s);
    expect(o.nodes.a).toBeUndefined();
    expect(o.nodes.b).toBeUndefined();
    expect(o.favorites).toEqual([]);
    expect(o.trash.map((e) => e.id)).toEqual(["a"]);
    tick(1);
    trashPages(s, ["b"]); // schon versteckt: nichts
    restorePages(s, ["a"]);
    expect(buildOutline(s).children.a).toEqual(["b"]);
    // b allein in den Papierkorb, dann a: b wiederherstellen → nach oben, weil a im Papierkorb liegt
    trashPages(s, ["b"]);
    tick(1);
    trashPages(s, ["a"]);
    o = buildOutline(s);
    expect(o.trash.map((e) => e.id)).toEqual(["a", "b"]);
    expect(o.trash[1]?.from).toBe("a");
    restorePages(s, ["b"]);
    expect(s.blocks.get("b")?.parent).toBe("w");
    expect(buildOutline(s).children[sectionKey("private")]).toEqual(["b"]);
    deleteForever(s, ["b"]);
    expect(s.blocks.has("b")).toBe(false);
    expect(s.blocks.has("t")).toBe(false);
    expect(s.workspace.favorites).toEqual([]);
    expect(p.tombstone(keyOf("block", "t"))).toBeDefined();
    emptyTrash(s);
    expect(trashedPages(s)).toEqual([]);
    expect(s.blocks.size).toBe(0);
  });

  it("Wiederherstellen stempelt den Inhalt neu", () => {
    const { s } = make([blk("a", "w", "a0"), blk("t", "b:a", "a0", "text")]);
    trashPages(s, ["a"]);
    const before = s.blocks.get("t")!.stamp!;
    restorePages(s, ["a"]);
    expect(s.blocks.get("t")!.stamp).not.toEqual(before);
  });

  it("Ziehen: davor, dahinter, hinein; nie in sich selbst", () => {
    const { s } = make([blk("a", "w", "a0"), blk("b", "w", "a1"), blk("c", "w", "a2"), blk("x", "b:a", "a0")]);
    expect(dropPages(s, ["c"], "a", "before")).toBe(true);
    expect(s.children("w")).toEqual(["c", "a", "b"]);
    expect(dropPages(s, ["c"], "b", "after")).toBe(true);
    expect(s.children("w")).toEqual(["a", "b", "c"]);
    expect(dropPages(s, ["b"], "a", "inside")).toBe(true);
    expect(s.children("b:a")).toEqual(["x", "b"]);
    expect(dropPages(s, ["a"], "b", "inside")).toBe(false);
    expect(dropPages(s, ["c"], "x", "before")).toBe(true);
    expect(s.children("b:a")).toEqual(["c", "x", "b"]);
    const t = createTeamspace(s, "T");
    movePages(s, ["c"], { kind: "top", section: { kind: "teamspace", id: t } });
    expect(buildOutline(s).children[sectionKey(t)]).toEqual(["c"]);
    expect(dropPages(s, ["b"], "c", "after")).toBe(true);
    expect(s.blocks.get("b")?.props?.teamspace).toBe(t);
  });

  it("Seiten im Toggle hängen unter ihrer Seite; Zeilen fehlen in der Seitenleiste", () => {
    const { s } = make([
      blk("a", "w", "a0"), blk("tog", "b:a", "a0", "toggle"), blk("sub", "b:tog", "a0"),
      blk("dbp", "b:a", "a1", "databasePage", { props: { databaseID: "db" } }), blk("row", "d:db", "a0"),
      { kind: "database", data: { id: "db", blockID: "dbp", title: "DB", properties: [], createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "x" } } },
    ]);
    const o = buildOutline(s);
    expect(o.children.a).toEqual(["sub", "dbp"]);
    expect(o.nodes.dbp?.kind).toBe("database");
    expect(o.nodes.row).toBeUndefined();
    expect(pageAncestors(s, "row")).toEqual(["a", "dbp"]);
    expect(pageAncestors(s, "sub")).toEqual(["a"]);
  });
});
