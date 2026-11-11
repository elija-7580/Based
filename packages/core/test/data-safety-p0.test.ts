// BSD-271: Schutzregeln aus den Swift-P0s (BSD-15/16/17/18/25/27/31) im TS-Kern. Was schon belegt war, ist im
// Backlog-Eintrag verlinkt; hier stehen die Lücken: Formel-/Rollup-Zyklen und Tiefe (BSD-17), unbekannte Felder
// nach lokaler Bearbeitung (BSD-25), Relationen beim Löschen, Typwechsel und Papierkorb (BSD-31).
import { describe, expect, it } from "vitest";
import {
  Formula, FormulaError, MemoryPersistence, QueryEngine, WorkspaceStore, changePropertyType, deleteProperty, deleteRows,
  makeRelationTwoWay, pv, restorePages, setRelation, setValue, type WireRecord,
} from "../src/index.js";

const stamp = { millis: 1, counter: 0, node: "x" };

function twoDatabases(extraTasks: object[] = [], extraProjects: object[] = []) {
  const records: WireRecord[] = [
    { kind: "block", data: { id: "dbblk", type: "databasePage", parent: "w", sk: "a0", props: { databaseID: "db" }, createdAt: 0, updatedAt: 0, stamp } },
    { kind: "block", data: { id: "pblk", type: "databasePage", parent: "w", sk: "a1", props: { databaseID: "proj" }, createdAt: 0, updatedAt: 0, stamp } },
    { kind: "database", data: { id: "db", blockID: "dbblk", title: "Tasks", createdAt: 0, updatedAt: 0, stamp, properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "est", name: "Estimate", type: "number" },
      { id: "proj", name: "Project", type: "relation", relation: { databaseID: "proj" } },
      ...extraTasks,
    ] } },
    { kind: "database", data: { id: "proj", blockID: "pblk", title: "Projects", createdAt: 0, updatedAt: 0, stamp, properties: [
      { id: "title", name: "Name", type: "title" },
      { id: "cost", name: "Cost", type: "number" },
      ...extraProjects,
    ] } },
    { kind: "block", data: { id: "r1", type: "page", parent: "d:db", sk: "a0", text: "R1", values: { est: pv("number", 2) }, createdAt: 0, updatedAt: 0, stamp } },
    { kind: "block", data: { id: "p1", type: "page", parent: "d:proj", sk: "a0", text: "Alpha", values: { cost: pv("number", 10) }, createdAt: 0, updatedAt: 0, stamp } },
    { kind: "block", data: { id: "p2", type: "page", parent: "d:proj", sk: "a1", text: "Beta", values: { cost: pv("number", 20) }, createdAt: 0, updatedAt: 0, stamp } },
  ] as WireRecord[];
  return new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n", now: () => 1000 });
}

describe("BSD-17: Formeln und Rollups stürzen nicht ab", () => {
  it("Zyklus zwischen zwei Formeln und Selbstbezug: leer mit Fehler „Circular reference“, kein Absturz", () => {
    const s = twoDatabases([
      { id: "fa", name: "A", type: "formula", formula: 'prop("B") + 1' },
      { id: "fb", name: "B", type: "formula", formula: 'prop("A") + 1' },
      { id: "fs", name: "Self", type: "formula", formula: 'prop("Self") * 2' },
      { id: "ok", name: "Ok", type: "formula", formula: 'prop("Estimate") * 2' },
    ]);
    const q = new QueryEngine(s);
    expect(() => q.valueById("r1", "fa")).not.toThrow();
    expect(q.valueById("r1", "fa")).toEqual({ t: "empty" });
    expect(q.error("r1", "fa")?.kind).toBe("cycle");
    expect(q.error("r1", "fb")?.kind).toBe("cycle");
    expect(q.valueById("r1", "fs")).toEqual({ t: "empty" });
    expect(q.error("r1", "fs")?.kind).toBe("cycle");
    // Unbeteiligte Formeln rechnen weiter.
    expect(q.valueById("r1", "ok")).toEqual({ t: "number", v: 4 });
  });

  it("Rollup-Zyklus über eine two-way-Relation: kein Absturz, Fehler statt Wert", () => {
    const s = twoDatabases([{ id: "roll", name: "Sum", type: "rollup", rollup: { relationPropertyID: "proj", targetPropertyID: "back", function: "sum" } }]);
    const m = makeRelationTwoWay(s, "db", "proj")!;
    s.transact("cfg", (tx) => {
      const d = structuredClone(s.databases.get("proj")!);
      d.properties.push({ id: "back", name: "Back", type: "rollup", rollup: { relationPropertyID: m, targetPropertyID: "roll", function: "sum" } });
      tx.put({ kind: "database", data: d });
    });
    setRelation(s, "r1", "proj", ["p1"]);
    expect(s.blocks.get("p1")!.values?.[m]).toBeDefined();
    const q = new QueryEngine(s);
    expect(() => q.valueById("r1", "roll")).not.toThrow();
    expect(["cycle", "tooDeep"]).toContain(q.error("r1", "roll")?.kind);
  });

  it("sehr tief verschachtelte Formel: Formelfehler statt Stack-Überlauf (vorher RangeError beim Parsen)", () => {
    const env = { prop: () => ({ t: "empty" as const }), now: 0 };
    for (const src of ["(".repeat(5000) + "1" + ")".repeat(5000), "-".repeat(5000) + "1", "[".repeat(3000) + "]".repeat(3000), "1" + " + 1".repeat(20000)]) {
      expect(() => Formula.evaluate(src, env), src.slice(0, 20)).toThrow(FormulaError);
      expect(() => Formula.evaluate(src, env)).toThrow(/too deeply nested/);
    }
  });

  it("Typfehler sind Fehlermeldungen, keine Ausnahmen anderer Art", () => {
    const env = { prop: () => ({ t: "empty" as const }), now: 0 };
    for (const src of ['"a" * 2', "true + [1]", 'dateAdd("x", 1, "days")', "length(1)", "now().year().upper()"]) {
      try { Formula.evaluate(src, env); } catch (e) { expect(e, src).toBeInstanceOf(FormulaError); }
    }
    // Normale Verschachtelung geht weiter.
    expect(Formula.evaluate("(".repeat(50) + "1" + ")".repeat(50), env)).toEqual({ t: "number", v: 1 });
  });
});

describe("BSD-25: unbekannte Felder und Blocktypen überleben eine lokale Bearbeitung", () => {
  it("Record einer neueren Version: Text ändern, verschieben – fremde Felder und Typ bleiben, auch im Speicher", () => {
    const p = new MemoryPersistence([]);
    const s = new WorkspaceStore({ persistence: p, node: "n", now: () => 1000 });
    const future = { kind: "block", data: { id: "f1", type: "hologram", parent: "w", sk: "a0", text: "alt", aiSummary: "neu", props: { glow: 3 }, createdAt: 0, updatedAt: 0, stamp } } as unknown as WireRecord;
    s.applyRemote([future]);
    s.setText("f1", "neu geschrieben");
    const r = s.record("block:f1" as never) as unknown as { data: Record<string, unknown> };
    expect(r.data.type).toBe("hologram");
    expect(r.data.aiSummary).toBe("neu");
    expect((r.data.props as Record<string, unknown>).glow).toBe(3);
    expect(r.data.text).toBe("neu geschrieben");
    const again = new WorkspaceStore({ persistence: p, node: "n", now: () => 2000 });
    const back = again.record("block:f1" as never) as unknown as { data: Record<string, unknown> };
    expect(back.data.aiSummary).toBe("neu");
    expect(back.data.type).toBe("hologram");
  });
});

describe("BSD-31: Relationen-Integrität", () => {
  it("Relation löschen: Gegenseite wird one-way und behält ihre Werte; Rollups über die Relation werden abgeschaltet; Undo stellt alles her", () => {
    const s = twoDatabases([{ id: "roll", name: "Cost sum", type: "rollup", rollup: { relationPropertyID: "proj", targetPropertyID: "cost", function: "sum" } }]);
    const m = makeRelationTwoWay(s, "db", "proj")!;
    setRelation(s, "r1", "proj", ["p1", "p2"]);
    expect(s.blocks.get("p1")!.values?.[m]).toBeDefined();
    deleteProperty(s, "db", "proj");
    const partner = s.databases.get("proj")!.properties.find((p) => p.id === m)!;
    expect(partner.relation?.syncedPropertyID).toBeUndefined();
    expect(s.blocks.get("p1")!.values?.[m]).toBeDefined();
    expect(s.blocks.get("r1")!.values?.proj).toBeUndefined();
    expect(s.databases.get("db")!.properties.find((p) => p.id === "roll")!.rollup).toBeUndefined();
    s.undo();
    expect(s.databases.get("proj")!.properties.find((p) => p.id === m)!.relation?.syncedPropertyID).toBe("proj");
    expect(s.blocks.get("r1")!.values?.proj).toBeDefined();
    expect(s.databases.get("db")!.properties.find((p) => p.id === "roll")!.rollup).toBeDefined();
  });

  it("Typwechsel Relation → Text löst die Gegenseite, Werte werden zu Titeln statt zu verschwinden", () => {
    const s = twoDatabases();
    setValue(s, "r1", "proj", pv("relation", ["p1", "p2"]));
    const m = makeRelationTwoWay(s, "db", "proj")!;
    changePropertyType(s, "db", "proj", "text");
    expect(s.databases.get("proj")!.properties.find((p) => p.id === m)?.relation?.syncedPropertyID).toBeUndefined();
    const v = s.blocks.get("r1")!.values?.proj;
    expect(JSON.stringify(v)).toMatch(/Alpha/);
  });

  it("Ziel in den Papierkorb: Relation zeigt es nicht mehr; wiederhergestellt ist es wieder da, ohne Datenverlust", () => {
    const s = twoDatabases();
    setValue(s, "r1", "proj", pv("relation", ["p1", "p2"]));
    const q = () => new QueryEngine(s).valueById("r1", "proj");
    expect(q()).toEqual({ t: "list", v: [{ t: "page", v: "p1" }, { t: "page", v: "p2" }] });
    deleteRows(s, ["p2"]);
    expect(q()).toEqual({ t: "list", v: [{ t: "page", v: "p1" }] });
    restorePages(s, ["p2"]);
    expect(q()).toEqual({ t: "list", v: [{ t: "page", v: "p1" }, { t: "page", v: "p2" }] });
  });
});
