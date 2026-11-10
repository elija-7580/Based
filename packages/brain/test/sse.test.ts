// Swift `SSEParserTests` (APIStreamingTests.swift) gegen dieselben Fixtures.
import { describe, expect, it } from "vitest";
import { SSEParser, type SSEEvent } from "../src/index.js";
import { bytes, chunks, fixture } from "./helpers.js";

describe("SSEParser", () => {
  it("überall geteilt ergibt dieselben Ereignisse", () => {
    const data = fixture("anthropic-stream.sse");
    const whole = new SSEParser();
    const expected = [...whole.feed(data), ...whole.finish()];
    expect(expected).toHaveLength(17);
    expect(expected[2]).toEqual({ event: "ping", data: '{"type":"ping"}' });
    for (const size of [1, 2, 3, 7, 64]) {
      const p = new SSEParser();
      const got: SSEEvent[] = [];
      for (const c of chunks(data, size)) got.push(...p.feed(c));
      got.push(...p.finish());
      expect(got, `chunk size ${size}`).toEqual(expected);
    }
  });

  it("CRLF, mehrzeilige Daten und Kommentare", () => {
    const p = new SSEParser();
    const text = ": keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata:x\n\ndata: tail";
    expect([...p.feed(bytes(text)), ...p.finish()]).toEqual([{ event: "a", data: "one\ntwo" }, { data: "x" }, { data: "tail" }]);
  });

  it("Mehrbyte-Zeichen über Stückgrenzen", () => {
    const p = new SSEParser();
    const data = bytes("data: Grüße 🌍\n\n");
    const got: SSEEvent[] = [];
    for (const c of chunks(data, 1)) got.push(...p.feed(c));
    expect(got).toEqual([{ data: "Grüße 🌍" }]);
  });
});
