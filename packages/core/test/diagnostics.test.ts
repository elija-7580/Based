// BSD-227: Diagnose – Log ohne Nutzerinhalte, Sitzungs-Marke, Hänger, Bericht.
import { describe, expect, it } from "vitest";
import {
  beginSession, buildReport, DiagnosticsLog, endSession, heartbeat, LOG_LIMIT, previousSessionNotice, redact, startStallDetector, type DiagnosticsStorage,
} from "../src/index.js";

const memory = (): DiagnosticsStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};

describe("Diagnose (BSD-227)", () => {
  it("redact: Token, Bearer, E-Mail, URL-Abfrage, zitierter Text, Länge", () => {
    const m = redact(`Sync error: 401 Bearer abc.def for ada@example.com at https://based.example/sync/v2/pull?after=3&token=x, token bdu_ABCDEFGHIJ1234 page “Geheimes Tagebuch” "Notiz"`);
    expect(m).not.toMatch(/abc\.def|ada@example|after=3|token=x|bdu_ABCDEF|Geheimes|Notiz/);
    expect(m).toContain("https://based.example/sync/v2/pull?‹…›");
    expect(redact("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });

  it("Log rotiert und schwärzt beim Eintragen", () => {
    let t = 0;
    const log = new DiagnosticsLog(() => ++t);
    for (let i = 0; i < LOG_LIMIT + 20; i++) log.add("info", `n ${i}`);
    expect(log.all).toHaveLength(LOG_LIMIT);
    expect(log.all[0]!.message).toBe("n 20");
    log.add("error", "failed for sk-ant-api03-XYZXYZXYZ");
    expect(log.all.at(-1)!.message).toBe("failed for ‹token›");
  });

  it("Sitzung: sauberes Ende ohne Hinweis, hartes Ende mit Hinweis und Log der vorigen Sitzung", () => {
    const s = memory();
    expect(beginSession(s, 1000)).toBeUndefined();
    endSession(s, 2000);
    const prev = beginSession(s, 3000)!;
    expect(prev.clean).toBe(true);
    expect(previousSessionNotice(prev)).toBeUndefined();
    heartbeat(s, 4000, { stalls: 2, log: [{ at: 3500, level: "error", message: "boom" }] });
    // kein endSession: Tab abgestürzt
    const crashed = beginSession(s, 9000)!;
    expect(crashed.clean).toBe(false);
    expect(crashed.lastBeat).toBe(4000);
    expect(previousSessionNotice(crashed)).toMatch(/didn't close normally.*2 freezes/);
    expect(buildReport({ version: "1.0" }, crashed, [], 9000)).toContain("boom");
  });

  it("Sitzung: wer nach einem „sauber beendet“ weiter schlägt, lebt noch (Fenster schließen, das offen blieb)", () => {
    const s = memory();
    beginSession(s, 1000);
    endSession(s, 2000);
    heartbeat(s, 3000);
    expect(beginSession(s, 4000)!.clean).toBe(false);
  });

  it("kaputte Marke im Speicher wird ignoriert", () => {
    const s = memory();
    s.data.set("based.diagnostics.session", "{kaputt");
    expect(beginSession(s, 1)).toBeUndefined();
  });

  it("Hänger: ein Zeitgeber, der 3 s zu spät kommt, wird gemeldet; pünktliche nicht", () => {
    let t = 0, tick: () => void = () => {};
    const stalls: number[] = [];
    const stop = startStallDetector({ now: () => t, setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => {}, onStall: (ms) => stalls.push(ms) });
    t += 1000; tick();
    t += 1100; tick();
    t += 4000; tick();
    stop();
    expect(stalls).toEqual([3000]);
  });

  it("Bericht: Fakten geschwärzt, keine Inhalte", () => {
    const log = new DiagnosticsLog(() => 0);
    log.add("warning", `Couldn't open “Meine Seite”`);
    const r = buildReport({ sync: "error (Bearer secret123)", pages: 12 }, undefined, log.all, 0);
    expect(r).toContain("pages: 12");
    expect(r).not.toMatch(/secret123|Meine Seite/);
    expect(r).toContain("previous session: none recorded");
  });
});
