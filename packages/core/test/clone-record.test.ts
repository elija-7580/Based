// BSD-435: cloneRecord ersetzt structuredClone in den heißen Pfaden des Stores – gleiche Kopie, nur schneller.
import { describe, expect, it } from "vitest";
import { cloneRecord } from "../src/index.js";

describe("cloneRecord", () => {
  it("kopiert tief wie structuredClone (auch undefined-Felder, null, Arrays, Fremdtypen)", () => {
    const rec = { kind: "block", data: { id: "a", text: [{ t: "x", m: { b: true, link: "https://e" } }], props: { n: null, u: undefined, list: [1, [2, { z: 3 }]] }, when: new Date(5), bytes: new Uint8Array([1, 2]) } };
    const c = cloneRecord(rec);
    expect(c).toEqual(structuredClone(rec));
    expect(Object.keys(c.data.props)).toEqual(["n", "u", "list"]);
    expect(c.data.text[0]!.m).not.toBe(rec.data.text[0]!.m);
    expect(c.data.props.list[1]).not.toBe(rec.data.props.list[1]);
    expect(c.data.when).toBeInstanceOf(Date);
    expect(c.data.when).not.toBe(rec.data.when);
    expect(c.data.bytes).toBeInstanceOf(Uint8Array);
    c.data.text[0]!.m.b = false;
    expect(rec.data.text[0]!.m.b).toBe(true);
    expect(cloneRecord("s")).toBe("s");
    expect(cloneRecord(null)).toBe(null);
  });
});
