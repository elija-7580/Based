// BSD-93: Agenten lesen und beschreiben ein Board als Text – knapp, ohne Koordinaten.
import { describe, expect, it } from "vitest";
import { boardHandles, boardOutline, planBoardScript, type WBConnector, type WBObject, type WBShape } from "../src/index.js";

const ids = () => { let n = 0; return () => `new${++n}`; };
const note = (id: string, x: number, text: string): WBShape => ({ id, kind: "note", z: "a" + id.length, x, y: 0, w: 168, h: 150, rot: 0, text });

describe("planBoardScript", () => {
  it("Knoten und Verbindungen: Spalten entlang der Pfeile, nichts überlappt, alles als Agenten-Arbeit markiert", () => {
    const plan = planBoardScript("note a: Idea\nbox b: Build it\nbox c: Ship\na -> b: then\nb -> c\n", [], ids());
    expect(plan.errors).toEqual([]);
    const [a, b, c] = ["a", "b", "c"].map((n) => plan.add.find((o) => o.id === plan.names.get(n)) as WBShape);
    expect(a!.x).toBeLessThan(b!.x);
    expect(b!.x).toBeGreaterThanOrEqual(a!.x + a!.w + 80);
    expect(c!.x).toBeGreaterThan(b!.x);
    expect(b!.style).toMatchObject({ shape: "rect", agent: true });
    const conns = plan.add.filter((o): o is WBConnector => o.kind === "connector");
    expect(conns).toHaveLength(2);
    expect(conns[0]).toMatchObject({ from: { id: a!.id }, to: { id: b!.id }, label: "then" });
  });
  it("Seitenkarte trägt die Seiten-ID; Rahmen umschließt seine Mitglieder und liegt hinten", () => {
    const plan = planBoardScript("page p: 0b6c2f10-aaaa\nnote n: next to it\np -> n\nframe f: Plan { p n }", [], ids());
    const page = plan.add.find((o) => o.kind === "page") as WBShape;
    expect(page.ref).toBe("0b6c2f10-aaaa");
    const frame = plan.add.find((o) => o.kind === "frame") as WBShape;
    const n = plan.add.find((o) => o.kind === "note") as WBShape;
    expect(frame.x).toBeLessThan(page.x);
    expect(frame.x + frame.w).toBeGreaterThan(n.x + n.w);
    expect(plan.add.every((o) => o === frame || o.z > frame.z)).toBe(true);
  });
  it("neuer Inhalt kommt rechts neben den vorhandenen; Verbindung zu einem vorhandenen Objekt über seine Kennung", () => {
    const old = [note("1f3c9a77-x", 0, "old")];
    const plan = planBoardScript("note a: new\n1f3c -> a", old, ids());
    expect((plan.add[0] as WBShape).x).toBe(168 + 96);
    expect(plan.add[1]).toMatchObject({ kind: "connector", from: { id: "1f3c9a77-x" } });
  });
  it("ohne Verbindungen: ein Raster statt einer langen Spalte", () => {
    const plan = planBoardScript(Array.from({ length: 9 }, (_, i) => `note n${i}: ${i}`).join("\n"), [], ids());
    expect(new Set(plan.add.map((o) => (o as WBShape).x)).size).toBe(3);
    expect(new Set(plan.add.map((o) => (o as WBShape).y)).size).toBe(3);
  });
  it("set und del über Kennungen; mit einem Objekt gehen seine Verbindungen; ein Kreis hängt nicht", () => {
    const a = note("aaaa1111", 0, "a"), b = note("bbbb2222", 300, "b");
    const conn: WBConnector = { id: "cccc3333", kind: "connector", z: "a9", from: { id: a.id, side: "auto" }, to: { id: b.id, side: "auto" }, shape: "curved" };
    const plan = planBoardScript("set aaaa: renamed\ndel bbbb\nbox x: 1\nbox y: 2\nx -> y\ny -> x", [a, b, conn], ids());
    expect(plan.patch.get("aaaa1111")).toEqual({ text: "renamed" });
    expect(plan.remove.sort()).toEqual(["bbbb2222", "cccc3333"]);
    expect(plan.add.filter((o) => o.kind === "shape")).toHaveLength(2);
  });
  it("Unverständliches wird gemeldet, der Rest gilt", () => {
    const plan = planBoardScript("note a: ok\nmake it pretty\na -> ghost\ndel zzzz", [], ids());
    expect(plan.add).toHaveLength(1);
    expect(plan.errors).toHaveLength(3);
  });
});

describe("boardOutline", () => {
  it("eine Zeile je Objekt mit kurzer Kennung; Tinte nur als Zahl; Verbindungen als Pfeile", () => {
    const a = note("aaaa1111", 0, "Idea"), b = note("aaab2222", 300, "Build\nit");
    const ink: WBShape = { id: "iiii", kind: "ink", z: "a5", x: 0, y: 0, w: 5, h: 5, rot: 0 };
    const conn: WBConnector = { id: "cccc", kind: "connector", z: "a9", from: { id: a.id, side: "auto" }, to: { id: b.id, side: "auto" }, shape: "curved", label: "then" };
    const objs: WBObject[] = [a, b, ink, conn];
    expect(boardHandles(objs).get(a.id)).toBe("aaaa");
    expect(boardOutline(objs)).toBe('aaaa note "Idea" @0,0\naaab note "Build it" @300,0\naaaa -> aaab: then\n(1 handwritten stroke)');
    expect(boardOutline([])).toBe("(empty board)");
  });
});
