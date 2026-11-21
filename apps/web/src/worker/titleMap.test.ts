// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// Titel-Tabelle der Shell: verhält sich wie eine Map, alte Stände bleiben unverändert, eine Änderung kopiert nicht alles.
import { describe, expect, it } from "vitest";
import { LayeredMap } from "./titleMap.js";

/** Kleiner deterministischer Zufall (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("LayeredMap (Titel-Tabelle)", () => {
  it("liest wie eine Map: get, has, size, Durchlauf; alte Stände bleiben, wie sie waren", () => {
    const a = LayeredMap.of([["p1", "One"], ["p2", "Two"]]);
    const b = a.with([["p2", "Zwei"], ["p3", "Drei"], ["p1", undefined]]);
    expect([...a]).toEqual([["p1", "One"], ["p2", "Two"]]);
    expect(a.size).toBe(2);
    expect(b.get("p1")).toBeUndefined();
    expect(b.has("p1")).toBe(false);
    expect(b.get("p2")).toBe("Zwei");
    expect(b.get("p3")).toBe("Drei");
    expect(b.size).toBe(2);
    expect(new Map(b)).toEqual(new Map([["p2", "Zwei"], ["p3", "Drei"]]));
    expect([...b.keys()]).toEqual(["p2", "p3"]);
    expect([...b.values()]).toEqual(["Zwei", "Drei"]);
    const seen: string[] = [];
    b.forEach((v, k, m) => { seen.push(`${k}=${v}`); expect(m).toBe(b); });
    expect(seen).toEqual(["p2=Zwei", "p3=Drei"]);
  });

  it("Entfernen, was es nicht gibt, und erneutes Setzen zählen richtig", () => {
    const a = LayeredMap.of([["x", "1"]]);
    const b = a.with([["nope", undefined], ["x", undefined], ["x", "2"], ["y", "3"], ["y", undefined]]);
    expect(b.size).toBe(1);
    expect(b.get("x")).toBe("2");
    expect(b.has("y")).toBe(false);
    // derselbe Wert wie in der Grundtabelle braucht keinen Eintrag in der Schicht
    expect(a.with([["x", "1"]]).size).toBe(1);
  });

  it("verhält sich bei vielen zufälligen Änderungen wie eine gewöhnliche Map (auch über das Zusammenlegen hinweg)", () => {
    const rand = rng(42);
    const ref = new Map<string, string>();
    for (let i = 0; i < 3000; i++) ref.set(`id${i}`, `t${i}`);
    let m = LayeredMap.of(ref);
    const states: { m: LayeredMap<string, string>; ref: Map<string, string> }[] = [];
    for (let step = 0; step < 400; step++) {
      const batch: [string, string | undefined][] = [];
      for (let j = 0, n = 1 + Math.floor(rand() * 20); j < n; j++) {
        const id = `id${Math.floor(rand() * 4000)}`;
        const v = rand() < 0.25 ? undefined : `t${Math.floor(rand() * 50)}`;
        batch.push([id, v]);
        if (v === undefined) ref.delete(id);
        else ref.set(id, v);
      }
      m = m.with(batch);
      if (step % 50 === 0) states.push({ m, ref: new Map(ref) });
      expect(m.size).toBe(ref.size);
    }
    expect(new Map(m)).toEqual(ref);
    for (let i = 0; i < 4000; i++) expect(m.get(`id${i}`)).toBe(ref.get(`id${i}`));
    // frühere Stände sind unverändert
    for (const s of states) expect(new Map(s.m)).toEqual(s.ref);
  });

  it("kopiert bei einer Änderung nicht die ganze Tabelle (120 000 Titel)", () => {
    const big = LayeredMap.of<string, string>(Array.from({ length: 120_000 }, (_, i) => [`id${i}`, `Title ${i}`] as const));
    const t0 = performance.now();
    let m = big;
    for (let i = 0; i < 200; i++) m = m.with([[`id${i}`, `Typed ${i}`]]);
    const per = (performance.now() - t0) / 200;
    expect(m.get("id5")).toBe("Typed 5");
    expect(m.size).toBe(120_000);
    // Eine Kopie aller Einträge dauert hier ~20 ms; eine Änderung muss weit darunter bleiben.
    expect(per).toBeLessThan(2);
  });
});
