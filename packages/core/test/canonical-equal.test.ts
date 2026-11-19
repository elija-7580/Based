// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-604: canonicalEqual sagt dasselbe wie der Vergleich der kanonischen Texte – nur ohne sie zu bauen.
import { describe, expect, it } from "vitest";
import { canonicalEqual, canonicalStringify } from "../src/index.js";

const byText = (a: unknown, b: unknown) => canonicalStringify(a) === canonicalStringify(b);

describe("canonicalEqual (BSD-604)", () => {
  const values: unknown[] = [
    null, true, false, 0, -0, 1, 1.5, "", "a", "1", [], [null], [undefined], [1, 2], [2, 1], {}, { a: undefined }, { a: 1 }, { a: 1, b: 2 }, { b: 2, a: 1 },
    { a: 1, b: undefined }, { a: null }, { a: [1, { b: "x" }] }, { a: [1, { b: "y" }] }, { a: { b: { c: 1 } } }, { a: { b: { c: 2 } } },
    Object.assign(Object.create(null), { a: 1 }), new Date(0), new Date(1), { d: new Date(0) }, { d: new Date(1) },
    { kind: "block", data: { id: "r1", values: { p: { uniqueID: { _0: 1 } } }, props: undefined } },
    { kind: "block", data: { id: "r1", values: { p: { uniqueID: { _0: 2 } } } } },
    { kind: "block", data: { values: { p: { uniqueID: { _0: 1 } } }, id: "r1" } },
  ];
  it("gleich wie der Text-Vergleich für alle Paare", () => {
    for (const a of values) for (const b of values) expect(canonicalEqual(a, b), `${canonicalStringify(a)} vs ${canonicalStringify(b)}`).toBe(byText(a, b));
  });
  it("wirft wie der Text-Vergleich bei Nicht-JSON ganz oben", () => {
    expect(() => canonicalEqual(undefined, undefined)).toThrow();
    expect(() => canonicalEqual(Number.NaN, Number.NaN)).toThrow();
  });
});
