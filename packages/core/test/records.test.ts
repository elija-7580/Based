// BSD-148: TS-Schemas gegen die Golden Fixtures aus Swift (fixtures/records/, `swift run based-fixtures`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalStringify, compareStamps, dateFromSwift, dateToSwift, encodeRecord, ENUMS, KNOWN_KEYS, parseRecord, safeParseRecord } from "../src/index.js";

const fixtures = fileURLToPath(new URL("../../../fixtures/records/", import.meta.url));
const lines = (text: string) => text.split("\n").filter((l) => l.length > 0);
const corpus = lines(readFileSync(fixtures + "corpus.jsonl", "utf8"));
const swift = JSON.parse(readFileSync(fixtures + "schema.json", "utf8")) as { keys: Record<string, string[]>; enums: Record<string, string[]> };

describe("Records aus Swift", () => {
  it("Korpus deckt alle Arten, Block-, Property- und View-Typen ab", () => {
    const recs = corpus.map((l) => JSON.parse(l));
    expect(new Set(recs.map((r) => r.kind))).toEqual(new Set(ENUMS.RecordKind));
    const blockTypes = new Set(recs.filter((r) => r.kind === "block").map((r) => r.data.type));
    for (const t of ENUMS.BlockType) expect(blockTypes, t).toContain(t);
    const propTypes = new Set(recs.filter((r) => r.kind === "database").flatMap((r) => r.data.properties.map((p: { type: string }) => p.type)));
    for (const t of ENUMS.PropertyType) expect(propTypes, t).toContain(t);
    const viewTypes = new Set(recs.filter((r) => r.kind === "view").map((r) => r.data.type));
    for (const t of ENUMS.ViewType) expect(viewTypes, t).toContain(t);
  });

  it.each(corpus.map((l, i) => [i + 1, l] as const))("Zeile %i parst und serialisiert byte-gleich", (_i, line) => {
    const rec = parseRecord(JSON.parse(line));
    expect(encodeRecord(rec)).toBe(line);
  });

  it("unbekannte Felder, Typen und Fälle bleiben erhalten", () => {
    const fut = corpus.map((l) => parseRecord(JSON.parse(l))).filter((r) => r.data.id.startsWith("fut") || r.data.id.endsWith("fut"));
    expect(fut.length).toBeGreaterThanOrEqual(4);
    const card = fut.find((r) => r.data.id === "fut-1")!;
    expect(card.data.type).toBe("kanbanCard");
    expect((card.data as Record<string, unknown>).aiSummary).toBe("neu");
  });
});

describe("Drift-Check gegen Swift", () => {
  it.each(Object.keys(swift.keys))("bekannte Schlüssel von %s", (name) => {
    expect([...KNOWN_KEYS[name as keyof typeof KNOWN_KEYS]].sort()).toEqual(swift.keys[name]);
  });
  it("es gibt keinen Swift-Typ ohne TS-Gegenstück", () => {
    expect(Object.keys(KNOWN_KEYS).sort()).toEqual(Object.keys(swift.keys).sort());
  });
  it.each(Object.keys(swift.enums))("Enum-Werte von %s", (name) => {
    expect([...ENUMS[name as keyof typeof ENUMS]]).toEqual(swift.enums[name]);
  });
  it("es gibt kein Swift-Enum ohne TS-Gegenstück", () => {
    expect(Object.keys(swift.enums).every((n) => n in ENUMS)).toBe(true);
  });
});

describe("Prüfung wie in Swift", () => {
  const base = JSON.parse(corpus.find((l) => l.includes('"id":"p-root"'))!);
  const broken = (edit: (d: Record<string, unknown>) => void) => {
    const r = structuredClone(base);
    edit(r.data);
    return safeParseRecord(r).ok;
  };
  it("fehlende Pflichtfelder werden abgelehnt", () => {
    expect(broken((d) => delete d.sk)).toBe(false);
    expect(broken((d) => delete d.createdAt)).toBe(false);
    expect(broken((d) => delete d.type)).toBe(false);
  });
  it("ungültiger parent wird abgelehnt", () => {
    expect(broken((d) => (d.parent = "x:1"))).toBe(false);
  });
  it("Enum-Fall mit zwei Schlüsseln wird abgelehnt", () => {
    expect(broken((d) => ((d.values as unknown) = { a: { text: { _0: "x" }, number: { _0: 1 } } }))).toBe(false);
  });
  it("unbekannte Art wird abgelehnt", () => {
    expect(safeParseRecord({ kind: "comment", data: base.data }).ok).toBe(false);
  });
});

describe("Hilfen", () => {
  it("HLC-Ordnung", () => {
    const a = { millis: 1, counter: 2, node: "a" };
    expect(compareStamps(a, { ...a, millis: 2 })).toBe(-1);
    expect(compareStamps(a, { ...a, counter: 1 })).toBe(1);
    expect(compareStamps(a, { ...a, node: "b" })).toBe(-1);
    expect(compareStamps(a, { ...a })).toBe(0);
  });
  it("Swift-Datum", () => {
    expect(dateFromSwift(0).toISOString()).toBe("2001-01-01T00:00:00.000Z");
    expect(dateToSwift(dateFromSwift(784000000.25))).toBeCloseTo(784000000.25, 6);
  });
  it("kanonisch: sortiert, ohne Leerzeichen, / unmaskiert", () => {
    expect(canonicalStringify({ b: 1, a: [true, null, "x/y"], c: undefined })).toBe('{"a":[true,null,"x/y"],"b":1}');
  });
});

// Echte Daten (optional): `swift run based-fixtures --records-from based.sqlite /tmp/records.jsonl`,
// dann `BASED_RECORDS=/tmp/records.jsonl pnpm --filter @based/core test`.
const real = process.env.BASED_RECORDS;
describe.runIf(Boolean(real))("echter Workspace (BASED_RECORDS)", () => {
  it("alle Records parsen und serialisieren byte-gleich", () => {
    const all = lines(readFileSync(real!, "utf8"));
    const failures: string[] = [];
    for (const line of all) {
      const r = safeParseRecord(JSON.parse(line));
      if (!r.ok) failures.push(line.slice(0, 160) + " → " + r.error.issues[0]?.message);
      else if (encodeRecord(r.record) !== line) failures.push(line.slice(0, 160) + " → nicht byte-gleich");
    }
    expect(failures.slice(0, 20), `${failures.length}/${all.length} fehlerhaft`).toEqual([]);
  });
});
