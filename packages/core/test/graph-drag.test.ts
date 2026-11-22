// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { describe, expect, it } from "vitest";
import { ForceLayout } from "../src/index.js";

// Ruhiges Ziehen im Seitengraph: wird in einem ruhenden Bild ein Knoten gezogen, folgt nur seine Umgebung – weich,
// ein Schritt je Frame – und der Rest des Bildes bleibt stehen. Vorher heizte jede Zeigerbewegung das ganze Bild an.

/** Kette 0–1–2–…–11 mit zwei Blättern an Knoten 1 und einem einzelnen Knoten ohne Kante. */
function chain() {
  const ids = Array.from({ length: 15 }, (_, i) => "N" + String(i).padStart(2, "0"));
  const links: [number, number][] = [];
  for (let i = 0; i < 11; i++) links.push([i, i + 1]);
  links.push([1, 12], [1, 13]);
  const l = new ForceLayout(ids, links);
  l.settle();
  return l;
}

describe("Seitengraph: ruhiges Ziehen", () => {
  it("nur die Umgebung des gezogenen Knotens bewegt sich, der Rest bleibt genau liegen", () => {
    const l = chain();
    expect(l.settled).toBe(true);
    const x0 = [...l.x], y0 = [...l.y];
    // Knoten 0 in 30 Frames 300 nach außen ziehen (weg vom Rest, damit niemand „im Weg“ liegt)
    const out = Math.hypot(x0[0]!, y0[0]!) || 1;
    const ux = x0[0]! / out, uy = y0[0]! / out;
    let biggest = 0;
    for (let f = 1; f <= 30; f++) {
      const before = [...l.x], beforeY = [...l.y];
      l.drag(0, x0[0]! + ux * f * 10, y0[0]! + uy * f * 10);
      expect(l.paced).toBe(true);
      l.advance(12);
      expect(l.steps).toBeGreaterThan(0);
      for (let i = 1; i < l.count; i++) biggest = Math.max(biggest, Math.hypot(l.x[i]! - before[i]!, l.y[i]! - beforeY[i]!));
    }
    const moved = (i: number) => Math.hypot(l.x[i]! - x0[i]!, l.y[i]! - y0[i]!);
    // der gezogene Knoten liegt unter dem Zeiger, sein Nachbar ist gefolgt, der übernächste weniger
    expect(Math.hypot(l.x[0]! - (x0[0]! + ux * 300), l.y[0]! - (y0[0]! + uy * 300))).toBeLessThan(0.01);
    expect(moved(1)).toBeGreaterThan(20);
    expect(moved(2)).toBeLessThan(moved(1));
    // mehr als drei Kanten entfernt und der Knoten ohne Kante: keine Bewegung
    for (const i of [4, 5, 6, 7, 8, 9, 10, 11, 14]) expect(moved(i)).toBe(0);
    // kein Knoten springt: je Frame höchstens eine halbe Kantenlänge
    expect(biggest).toBeLessThanOrEqual(l.linkDistance * 0.5 + 1e-3);
  });

  it("je Frame genau ein Schritt, auch mit großem Budget", () => {
    const l = chain();
    l.drag(0, l.x[0]! + 40, l.y[0]!);
    const before = l.steps;
    l.advance(1000);
    expect(l.steps).toBe(before + 1);
  });

  it("nach dem Loslassen bleibt der Knoten liegen und das Bild ruht nach knapp zwei Sekunden", () => {
    const l = chain();
    const tx = l.x[0]! + 200, ty = l.y[0]! - 120;
    l.drag(0, tx, ty);
    l.advance(12);
    l.drop();
    let frames = 0;
    while (!l.settled && frames < 500) { l.advance(12); frames += 1; }
    expect(l.settled).toBe(true);
    expect(frames).toBeLessThan(120); // 60 Frames je Sekunde
    expect(l.x[0]).toBeCloseTo(tx, 3);
    expect(l.y[0]).toBeCloseTo(ty, 3);
    expect([...l.x, ...l.y].every(Number.isFinite)).toBe(true);
  });

  it("ein Knoten, auf den der gezogene gelegt wird, weicht aus – auch ohne Kante", () => {
    const l = chain();
    const before = { x: l.x[14]!, y: l.y[14]! };
    l.drag(0, before.x + 6, before.y + 4);
    for (let f = 0; f < 40; f++) l.advance(12);
    expect(Math.hypot(l.x[14]! - l.x[0]!, l.y[14]! - l.y[0]!)).toBeGreaterThan(12);
  });

  it("läuft der Aufbau noch, rechnet er beim Ziehen ungebremst weiter", () => {
    const ids = ["A", "B", "C", "D"];
    const l = new ForceLayout(ids, [[0, 1], [1, 2], [2, 3]]);
    l.step();
    l.drag(0, 50, 50);
    expect(l.paced).toBe(false);
    l.settle();
    expect(l.x[0]).toBeCloseTo(50, 3);
  });
});
