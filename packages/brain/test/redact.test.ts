import { describe, expect, it } from "vitest";
import {
  detectSensitive, ibanValid, luhnValid, redactionPlan, RedactingEngine, RedactingProvider, Redactor, ModelEngine, ScriptedEngine,
  type RedactKind,
} from "../src/index.js";
import { collect, ScriptedProvider } from "./helpers.js";

// Synthetische Testsätze (keine echten Daten): erwartete Arten in Reihenfolge.
const GOLDEN: { text: string; kinds: RedactKind[]; keep?: string[] }[] = [
  { text: "Schreib an anna.schmidt@example.org wegen des Termins.", kinds: ["EMAIL"] },
  { text: "Ruf mich an unter +49 30 1234567 oder 0151-23456789.", kinds: ["PHONE", "PHONE"] },
  { text: "Meine IBAN ist DE89 3704 0044 0532 0130 00, bitte überweisen.", kinds: ["IBAN"] },
  { text: "Card 4111 1111 1111 1111 expires soon; 4111 1111 1111 1112 is a typo.", kinds: ["CARD"], keep: ["4111 1111 1111 1112"] },
  { text: "Lieferadresse: Berliner Straße 12a, 10115 Berlin.", kinds: ["ADDRESS"] },
  { text: "Ship it to 221 Baker Street, London.", kinds: ["ADDRESS"] },
  { text: "Hauptstraße 5 ist das Büro.", kinds: ["ADDRESS"] },
  { text: "My key is sk-ant-api03-abcdefghijklmnopqrstuvwx and the GitHub token ghp_abcdefghijklmnopqrstuvwxyz0123.", kinds: ["SECRET", "SECRET"] },
  { text: "password: hunter2hunter2 in the config", kinds: ["SECRET"] },
  { text: "Meeting mit Anna Schmidt und Jonas am Montag.", kinds: ["PERSON", "PERSON"] },
  { text: "Am 10.11.2026 um 14:30 waren es 1234567 Besucher (2026-11-10).", kinds: [], keep: ["10.11.2026", "2026-11-10"] },
  { text: "Version 3.14.159 and order #12345678 are not sensitive.", kinds: [] },
];
const NAMES = ["Anna Schmidt", "Jonas Weber"];

describe("redaction rules (BSD-199, stage 1)", () => {
  it("checksums: Luhn and IBAN mod 97", () => {
    expect(luhnValid("4111111111111111")).toBe(true);
    expect(luhnValid("4111111111111112")).toBe(false);
    expect(ibanValid("DE89 3704 0044 0532 0130 00")).toBe(true);
    expect(ibanValid("DE89 3704 0044 0532 0130 01")).toBe(false);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
  });

  for (const g of GOLDEN) {
    it(`golden: ${g.text.slice(0, 40)}…`, () => {
      const found = detectSensitive(g.text, { names: NAMES });
      expect(found.map((d) => d.kind)).toEqual(g.kinds);
      const r = new Redactor({ names: NAMES });
      const out = r.redact(g.text);
      for (const d of found) expect(out.text).not.toContain(d.value);
      for (const k of g.keep ?? []) expect(out.text).toContain(k);
      // Rücktausch ergibt genau den Ausgangstext.
      expect(r.restore(out.text)).toBe(g.text);
    });
  }

  it("only selected kinds", () => {
    expect(detectSensitive("mail a@b.de, call +49 30 1234567", { kinds: new Set(["PHONE"]) }).map((d) => d.kind)).toEqual(["PHONE"]);
  });
});

describe("Redactor", () => {
  it("same value → same placeholder across texts, numbered per kind", () => {
    const r = new Redactor({ names: NAMES });
    const a = r.redact("Anna Schmidt: anna@example.org").text;
    const b = r.redact("Again anna@example.org and Jonas Weber").text;
    expect(a).toBe("<PERSON_1>: <EMAIL_1>");
    expect(b).toBe("Again <EMAIL_1> and <PERSON_2>");
    expect(r.turnSummary()).toEqual({ count: 3, kinds: { PERSON: 2, EMAIL: 1 } });
    r.beginTurn();
    expect(r.turnSummary().count).toBe(0);
  });

  it("restores placeholders the model wrote without brackets, leaves unknown ones", () => {
    const r = new Redactor();
    r.redact("x@y.de");
    expect(r.restore("Send to EMAIL_1 and <EMAIL_9>.")).toBe("Send to x@y.de and <EMAIL_9>.");
  });

  it("does not redact its own placeholders again", () => {
    const r = new Redactor({ names: ["Persona Name"] });
    const once = r.redact("Persona Name").text;
    expect(r.redact(once).text).toBe(once);
  });

  it("stream restorer holds back a placeholder split over deltas", () => {
    const r = new Redactor({ names: NAMES });
    r.redact("Anna Schmidt");
    const s = r.streamRestorer();
    const parts = ["Hello <PERS", "ON_1>, how", " are you? <", "PERSON_1>"].map((p) => s.push(p));
    expect(parts.join("") + s.flush()).toBe("Hello Anna Schmidt, how are you? Anna Schmidt");
    expect(parts[0]).toBe("Hello ");
  });

  it("JSON (tool arguments) both ways", () => {
    const r = new Redactor({ names: NAMES });
    const red = r.redactJSON({ title: "Call Anna Schmidt", tags: ["anna@example.org"], n: 3 });
    expect(red).toEqual({ title: "Call <PERSON_1>", tags: ["<EMAIL_1>"], n: 3 });
    expect(r.restoreJSON(red)).toEqual({ title: "Call Anna Schmidt", tags: ["anna@example.org"], n: 3 });
  });

  it("a local model can add detections (stage 2 interface)", async () => {
    const model = { id: "fake", detect: async (t: string) => [{ start: t.indexOf("Projekt Nordlicht"), end: t.indexOf("Projekt Nordlicht") + 17, kind: "PERSON" as const }] };
    const r = new Redactor({ model });
    const out = await r.redactAsync("Codename Projekt Nordlicht, mail a@b.de");
    expect(out.text).toBe("Codename <PERSON_1>, mail <EMAIL_1>");
  });
});

describe("redaction in the engine layer", () => {
  it("plan: off when disabled or local, warn for CLI engines", () => {
    expect(redactionPlan(false, "external")).toBe("off");
    expect(redactionPlan(true, "local")).toBe("off");
    expect(redactionPlan(true, "external")).toBe("redact");
    expect(redactionPlan(true, "cli")).toBe("warn");
  });

  it("provider sees only placeholders (prompt, history, tool results); tools run and answers show real values", async () => {
    const r = new Redactor({ names: NAMES });
    const provider = new ScriptedProvider([
      { calls: [{ id: "c1", name: "lookup", arguments: { who: "<PERSON_1>" } }] },
      { text: "Done: <PERSON_1> lives at <ADDRESS_1>." },
    ]);
    const calls: unknown[] = [];
    const tools = {
      specs: [{ name: "lookup", description: "", inputSchema: {} }],
      isWrite: () => false,
      call: async (_n: string, input: unknown) => {
        calls.push(input);
        return { text: "Anna Schmidt, Berliner Straße 12a, 10115 Berlin", isError: false };
      },
    };
    const engine = new ModelEngine({ provider: new RedactingProvider(provider, r), model: "m", tools, policy: { mode: "free" }, today: () => "2026-11-10" });
    const events = await collect(engine.run({ prompt: "Where does Anna Schmidt live?", history: [{ role: "user", content: "Mail: anna@example.org" }, { role: "assistant", content: "ok" }] }, new AbortController().signal));
    const sent = JSON.stringify(provider.seen);
    for (const secret of ["Anna Schmidt", "anna@example.org", "Berliner Straße"]) expect(sent).not.toContain(secret);
    expect(sent).toContain("<PERSON_1>");
    expect(calls).toEqual([{ who: "Anna Schmidt" }]);
    const text = events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("Done: Anna Schmidt lives at Berliner Straße 12a, 10115 Berlin.");
    const deltas = events.filter((e) => e.type === "textDelta").map((e) => (e as { text: string }).text).join("");
    expect(deltas).toBe(text);
  });

  it("RedactingEngine wraps engines without a provider interface", async () => {
    const r = new Redactor({ names: NAMES });
    const inner = new ScriptedEngine({ script: (req) => [{ text: `You wrote: ${req.prompt}`, chunk: 5 }] });
    const events = await collect(new RedactingEngine(inner, r).run({ prompt: "Call Jonas Weber at +49 30 1234567" }, new AbortController().signal));
    expect(inner.requests[0]!.prompt).toBe("Call <PERSON_1> at <PHONE_1>");
    expect(events.find((e) => e.type === "text")).toEqual({ type: "text", text: "You wrote: Call Jonas Weber at +49 30 1234567" });
    expect(events.filter((e) => e.type === "textDelta").map((e) => (e as { text: string }).text).join("")).toBe("You wrote: Call Jonas Weber at +49 30 1234567");
  });
});

import { privacyGate } from "../src/redact/wrap.js";
describe("privacyGate (BSD-184)", () => {
  it("kein Treffer oder lokal → senden; Schwärzen an → schwärzen; sonst fragen; Wahl gilt", () => {
    expect(privacyGate({ hits: 0, reach: "external", redactAlways: false })).toBe("send");
    expect(privacyGate({ hits: 2, reach: "local", redactAlways: false })).toBe("send");
    expect(privacyGate({ hits: 2, reach: "external", redactAlways: false })).toBe("ask");
    expect(privacyGate({ hits: 2, reach: "external", redactAlways: true })).toBe("redact");
    expect(privacyGate({ hits: 2, reach: "external", redactAlways: false, decision: "redact" })).toBe("redact");
    expect(privacyGate({ hits: 2, reach: "external", redactAlways: false, decision: "raw" })).toBe("send");
    expect(privacyGate({ hits: 2, reach: "cli", redactAlways: false, decision: "redact" })).toBe("send");
  });
});
