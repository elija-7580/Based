// ADR 0017 Stufe B: Die Gliederung aus dem Gerüst ist dieselbe wie die Tiefensuche über alle Blöcke.
import { describe, expect, it } from "vitest";
import { buildOutline, buildOutlineByWalk, MemoryPersistence, WorkspaceStore, type WireRecord } from "../src/index.js";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** Zufälliger Baum mit allem, was die Gliederung unterscheidet. */
function workspace(seed: number): WireRecord[] {
  const rnd = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const out: WireRecord[] = [];
  const stamp = { millis: 1, counter: 0, node: "s" };
  out.push({ kind: "workspace", data: { id: "workspace", name: "W", favorites: [], teamspaces: [{ id: "ts1", name: "Team" }], createdAt: 0, updatedAt: 0, stamp } } as never);
  const parents = ["w", "w", "w"];
  const sks = ["a0", "a1", "a1", "a2", "b0", "Zz", "a0V"]; // gleiche Schlüssel kommen vor: dann entscheidet die ID
  for (let i = 0; i < 90; i++) {
    const id = "n" + String(i).padStart(2, "0");
    const r = rnd();
    const type = r < 0.3 ? "page" : r < 0.36 ? "databasePage" : r < 0.46 ? "databaseInline" : r < 0.7 ? "toggle" : "text";
    const parent = rnd() < 0.05 ? "b:missing" + i : rnd() < 0.05 ? "d:db-rows" : pick(parents);
    const data: Record<string, unknown> = { id, type, parent, sk: pick(sks), text: "T" + i, createdAt: 0, updatedAt: 0, stamp };
    const props: Record<string, unknown> = {};
    if (rnd() < 0.08) data.trashedAt = 10 + i;
    if (rnd() < 0.15) props.icon = rnd() < 0.5 ? "🙂" : { emoji: "📄" };
    if (parent === "w" && rnd() < 0.3) props.teamspace = rnd() < 0.8 ? "ts1" : "gone";
    if (type === "databaseInline" || type === "databasePage") {
      const db = "db" + i;
      props.databaseID = db;
      // meist eigene Datenbank, manchmal nur eine verknüpfte Ansicht
      out.push({ kind: "database", data: { id: db, blockID: rnd() < 0.7 ? id : "other", title: "DB " + i, properties: [], createdAt: 0, updatedAt: 0, stamp } } as never);
    }
    if (Object.keys(props).length) data.props = props;
    out.push({ kind: "block", data } as never);
    if (type !== "text") parents.push("b:" + id, "b:" + id);
  }
  return out;
}

describe("Gliederung aus dem Gerüst (ADR 0017 Stufe B)", () => {
  for (let seed = 1; seed <= 40; seed++) {
    it(`gleich wie die Tiefensuche, voll geladen und nach Bedarf (Saat ${seed})`, () => {
      const records = workspace(seed);
      const eager = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n", lazy: false, propertyRecords: false });
      const lazy = new WorkspaceStore({ persistence: new MemoryPersistence(records), node: "n", lazy: true, propertyRecords: false });
      const expected = buildOutlineByWalk(eager);
      expect(buildOutline(eager)).toEqual(expected);
      expect(buildOutline(lazy)).toEqual(expected);
      expect(lazy.fullLoads, "die Gliederung lädt nicht alles nach").toBe(0);
      // nicht trivial: es gibt verschachtelte Einträge
      if (seed === 1) expect(Object.values(expected.nodes).some((n) => n.parent)).toBe(true);
    });
  }

  it("deckt die besonderen Fälle wirklich ab (über alle Saaten)", () => {
    let nested = 0, shared = 0, inline = 0, trash = 0, team = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const o = buildOutline(new WorkspaceStore({ persistence: new MemoryPersistence(workspace(seed)), node: "n", lazy: true, propertyRecords: false }));
      nested += Object.values(o.nodes).filter((n) => n.parent).length;
      shared += o.children["section:shared"]?.length ?? 0;
      inline += Object.entries(o.nodes).filter(([, n]) => n.kind === "database" && n.parent).length;
      trash += o.trash.length;
      team += o.children["section:ts1"]?.length ?? 0;
    }
    for (const n of [nested, shared, inline, trash, team]) expect(n).toBeGreaterThan(5);
  });
});
