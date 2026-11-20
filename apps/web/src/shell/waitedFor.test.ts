// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Feedback 20. 11.: Eine wartende Store-Anfrage nennt die lange Arbeit im Worker, hinter der sie stand.
import { describe, expect, it } from "vitest";
import { waitedFor } from "./hangs.js";

describe("waitedFor", () => {
  const busy = [{ op: "search", ms: 300, end: 100 }, { op: "backlinks", ms: 9000, end: 9500 }, { op: "graph", ms: 800, end: 20_000 }];
  it("nennt die längste Arbeit, die während des Wartens endete", () => {
    expect(waitedFor(400, 9600, busy)).toBe("backlinks");
  });
  it("nichts, wenn die Arbeit zu kurz für die Wartezeit war oder außerhalb lag", () => {
    expect(waitedFor(19_000, 23_000, busy)).toBeUndefined();
    expect(waitedFor(10_000, 11_000, busy)).toBeUndefined();
  });
});
