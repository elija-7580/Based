// BSD-522 Teil 1: Kennungen und Regeln der Herkunft (rein, ohne Store) und das additive Datenformat.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authorID, authorKindOf, checkOriginChange, encodeRecord, originAfterEdit, parseRecord, ProvenanceError, type Author } from "../src/index.js";

const claude: Author = { kind: "agent", name: "Claude Code", model: "model-x" };

describe("BSD-522 Kennungen", () => {
  it("deterministisch, Art im Präfix, Name und Modell ohne Rücksicht auf Groß-/Kleinschreibung", () => {
    expect(authorID(claude)).toBe(authorID({ kind: "agent", name: " claude code ", model: "MODEL-X" }));
    expect(authorID(claude)).not.toBe(authorID({ kind: "agent", name: "Claude Code" }));
    expect(authorKindOf(authorID(claude))).toBe("agent");
    expect(authorKindOf(authorID({ kind: "guest", name: "Ana" }))).toBe("guest");
    expect(authorKindOf(authorID({ kind: "user", name: "Elija" }))).toBe("user");
    expect(authorKindOf(undefined)).toBeUndefined();
    expect(authorID(claude).length).toBeLessThanOrEqual(9);
  });
});

describe("BSD-522 Regeln", () => {
  it("automatisch: Agent → ai (neu oder ai) sonst mixed; Mensch an ai → mixed, sonst unverändert", () => {
    expect(originAfterEdit(undefined, claude, true)).toBe("ai");
    expect(originAfterEdit("ai", claude, false)).toBe("ai");
    for (const o of [undefined, "human", "reviewed", "mixed"]) expect(originAfterEdit(o, claude, false)).toBe("mixed");
    expect(originAfterEdit("ai", undefined, false)).toBe("mixed");
    for (const o of [undefined, "human", "reviewed", "mixed"]) expect(originAfterEdit(o, undefined, false)).toBe(o);
    expect(originAfterEdit(undefined, undefined, true)).toBeUndefined();
    expect(originAfterEdit("ai", { kind: "guest", name: "Ana" }, false)).toBe("mixed");
  });

  it("ausdrücklich: Agent nur ai, reviewed nur der Nutzer, unbekannte Werte nicht", () => {
    for (const o of ["human", "reviewed", "mixed", undefined]) expect(() => checkOriginChange(o, claude)).toThrow(ProvenanceError);
    expect(() => checkOriginChange("ai", claude)).not.toThrow();
    expect(() => checkOriginChange("reviewed", { kind: "guest", name: "Ana" })).toThrow(ProvenanceError);
    expect(() => checkOriginChange("bogus", undefined)).toThrow(ProvenanceError);
    for (const o of ["human", "reviewed", "mixed", "ai", undefined]) expect(() => checkOriginChange(o, undefined)).not.toThrow();
  });
});

describe("BSD-522 Datenformat: rein additiv", () => {
  it("alte Records (fixtures/records/corpus.jsonl) lesen und schreiben sich byte-gleich, ohne neue Felder", () => {
    const lines = readFileSync(new URL("../../../fixtures/records/corpus.jsonl", import.meta.url), "utf8").split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) {
      const r = parseRecord(JSON.parse(l));
      expect(encodeRecord(r)).toBe(l);
      if (r.kind === "block") expect([r.data.origin, r.data.author]).toEqual([undefined, undefined]);
      if (r.kind === "workspace") expect(r.data.authors).toBeUndefined();
    }
  });

  it("neue Felder und unbekannte Werte einer neueren Version überstehen Parsen und Kodieren", () => {
    const block = { kind: "block", data: { id: "x", type: "page", parent: "w", sk: "a0", createdAt: 0, updatedAt: 0, origin: "futureValue", author: "a-1" } };
    expect(JSON.parse(encodeRecord(parseRecord(block)))).toEqual(block);
    const ws = { kind: "workspace", data: { id: "w", name: "W", favorites: [], createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "n" }, authors: { "a-1": { kind: "agent", name: "Claude Code", model: "m", extra: 1 } } } };
    expect(JSON.parse(encodeRecord(parseRecord(ws)))).toEqual(ws);
  });
});
