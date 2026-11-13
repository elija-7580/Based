// BSD-319: „Problem melden“ – Ringpuffer, Text ersetzen, Bündel ohne Nutzertext und Token, Layout, Wiedergabe-Plan.
import { describe, expect, it } from "vitest";
import { cpuTime, expectWithinBudget } from "./perf-budget.js";
import {
  buildBugBundle, bundleID, comboFor, InputRecorder, layoutIssues, normalizeDoc, parseBugBundle, replayPlan, scrambleHTML, scrambleText,
  type BugBundleInput, type RecordedEvent,
} from "../src/index.js";

const SECRET = "Geheimes Tagebuch über Ada";
const TOKEN = "sk-ant-api03-XYZXYZXYZ";

const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "blockGroup", content: [{ type: "blockContainer", attrs: { id: "b1", textColor: "default" }, content: [{ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "link", attrs: { href: "https://example.com/" + text } }] }] }] }] }],
});

function input(events: RecordedEvent[], realText = false): BugBundleInput {
  return {
    id: "20261111-170512-ab3f", now: Date.UTC(2026, 10, 11), note: `Text sprang nach oben, token ${TOKEN}`, realText,
    app: { shell: "web", version: "0.1.0", commit: "abc1234" },
    env: { width: 1280, height: 820, dpr: 2, zoom: 1, theme: "light" },
    state: { root: "p1", doc: doc(SECRET + " " + TOKEN), blocks: [{ id: "b1", type: "paragraph", content: [{ type: "text", text: SECRET, styles: {} }], children: [] }], sel: { type: "text", anchor: 3, head: 3 }, focus: "div.ProseMirror", menus: [] },
    layout: [], events, log: [{ at: 1, level: "info", message: "start" }],
  };
}

const events = (): RecordedEvent[] => [
  { t: 1, kind: "checkpoint", root: "p1", doc: () => doc(SECRET), sel: { type: "text", anchor: 3, head: 3 } },
  { t: 2, kind: "key", root: "p1", key: "G", code: "KeyG", mods: { shift: true } },
  { t: 3, kind: "input", root: "p1", inputType: "insertText", data: "G" },
  { t: 4, kind: "key", root: "p1", key: "b", code: "KeyB", mods: { meta: true } },
  { t: 5, kind: "composition", root: "p1", phase: "end", data: "日本" },
  { t: 6, kind: "paste", root: "p1", plain: SECRET, html: `<p class="x" data-href="${SECRET}">${SECRET}</p>`, files: 0 },
  { t: 7, kind: "tr", root: "p1", steps: () => [{ stepType: "replace", from: 3, to: 3, slice: { content: [{ type: "text", text: SECRET }] } }], docChanged: true, sel: { type: "text", anchor: 4, head: 4 } },
  { t: 8, kind: "yjs", root: "p1", bytes: 40, origin: "y-sync", update: () => new TextEncoder().encode(SECRET) },
];

describe("Text ersetzen", () => {
  it("behält Länge, Wortgrenzen, Zeichenklassen, Satzzeichen und Emoji", () => {
    expect(scrambleText("Hallo Welt, 42 Äpfel! 🍎 - [ ] #")).toBe("Xxxxx Xxxx, 00 Xxxxx! 🍎 - [ ] #");
    const s = "Ünïcödé 𝔸 日本語";
    expect(scrambleText(s).length).toBe(s.length);
  });

  it("HTML: Text und Attributwerte ersetzt, Klassen und Tags bleiben", () => {
    const h = scrambleHTML(`<p class="bn-x" href="https://secret.example/a">Hi <b>Ada</b></p>`);
    expect(h).toBe(`<p class="bn-x" href="xxxxx://xxxxxx.xxxxxxx/x">Xx <b>Xxx</b></p>`);
  });
});

describe("Bündel (BSD-319)", () => {
  it("Standard: kein Nutzertext und kein Token im ganzen Bündel", () => {
    const b = buildBugBundle(input(events()));
    const json = JSON.stringify(b);
    for (const word of ["Geheimes", "Tagebuch", "Ada", "XYZXYZ", "sk-ant", "日本", "example.com"]) expect(json).not.toContain(word);
    // Struktur bleibt: Typen, IDs, Länge des Textes, Kürzel
    expect(json).toContain("blockContainer");
    expect(json).toContain('"b1"');
    expect(json).toContain("Xxxxxxxx Xxxxxxxx xxxx Xxx");
    const key = b.recording.events[1] as { key: string; code?: string };
    expect(key.key).toBe("X");
    expect(key.code).toBeUndefined();
    expect((b.recording.events[3] as { key: string; code: string }).key).toBe("b");
    expect((b.recording.events[3] as { code: string }).code).toBe("KeyB");
    expect((b.recording.events[7] as { update?: string }).update).toBeUndefined();
    expect(b.note).toContain("‹token›");
  });

  it("echter Text nur auf Wunsch – Token und E-Mails trotzdem geschwärzt", () => {
    const b = buildBugBundle(input(events(), true));
    const json = JSON.stringify(b);
    expect(json).toContain("Geheimes Tagebuch");
    expect(json).not.toContain("XYZXYZ");
    expect((b.recording.events[7] as { update?: string }).update).toBeTypeOf("string");
  });

  it("parse/ID", () => {
    expect(parseBugBundle(JSON.parse(JSON.stringify(buildBugBundle(input(events())))))?.id).toBe("20261111-170512-ab3f");
    expect(parseBugBundle({ format: "x" })).toBeUndefined();
    expect(bundleID(Date.UTC(2026, 10, 11, 17, 5, 12), () => 0.5)).toBe("20261111-170512-8000");
  });
});

describe("Ringpuffer", () => {
  it("hält Grenze und Zeitfenster ein und beginnt immer mit einem Zwischenstand", () => {
    let t = 0;
    const r = new InputRecorder({ now: () => t, limit: 100, windowMs: 10_000, checkpointEvery: 20, checkpoints: () => [{ kind: "checkpoint", root: "p1", doc: {}, sel: { type: "text", anchor: 1, head: 1 } }] });
    r.record({ kind: "checkpoint", root: "p1", doc: {}, sel: { type: "text", anchor: 1, head: 1 } });
    for (let i = 0; i < 1000; i++) { t += 5; r.record({ kind: "key", key: "a", mods: {} }); }
    const s = r.snapshot();
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s[0]!.kind).toBe("checkpoint");
    t += 60_000;
    r.record({ kind: "key", key: "a", mods: {} });
    expect(r.snapshot().every((e) => e.t >= t - 10_000)).toBe(true);
    r.on = false;
    r.record({ kind: "key", key: "a", mods: {} });
    expect(r.size).toBe(0);
  });

  it("Zwischenstände nur vor einer Taste, nie zwischen Taste und beforeinput", () => {
    const r = new InputRecorder({ checkpointEvery: 3, checkpoints: () => [{ kind: "checkpoint", root: "p", doc: {}, sel: { type: "text", anchor: 1, head: 1 } }] });
    for (let i = 0; i < 30; i++) {
      r.record({ kind: "key", key: "a", mods: {} });
      r.record({ kind: "input", inputType: "insertText", data: "a" });
      r.record({ kind: "tr", root: "p", steps: [], docChanged: true, sel: { type: "text", anchor: 1, head: 1 } });
    }
    const kinds = r.snapshot().map((e) => e.kind);
    kinds.forEach((k, i) => { if (k === "checkpoint") expect(kinds[i + 1]).toBe("key"); });
    expect(kinds.filter((k) => k === "checkpoint").length).toBeGreaterThan(5);
  });

  it("kostet beim Tippen kaum etwas (10 000 Ereignisse < 50 ms)", () => {
    const r = new InputRecorder({ checkpoints: () => [{ kind: "checkpoint", root: "p", doc: () => ({}), sel: { type: "text", anchor: 1, head: 1 } }] });
    // CPU-Zeit, beste von drei Versuchen, in der CI nur Warnung (perf-budget.ts) – unter `pnpm -r test` kippte die
    // Wanduhr-Messung bei parallel laufenden Paketen.
    expectWithinBudget("InputRecorder 10 000 Ereignisse", { ms: 50 }, () => ({ ms: cpuTime(() => { for (let i = 0; i < 10_000; i++) r.record({ kind: "key", key: "a", mods: {} }); }) }));
  });
});

describe("Layout", () => {
  it("meldet eine deckende Fläche über dem markierten Block", () => {
    const issues = layoutIssues([
      { kind: "block", label: "paragraph #b1", rect: { x: 0, y: 0, w: 100, h: 20 }, selected: true },
      { kind: "block", label: "paragraph #b2", rect: { x: 0, y: 30, w: 100, h: 20 } },
      { kind: "floating", label: "div.bn-toolbar", rect: { x: 0, y: 0, w: 100, h: 10 }, opaque: true },
      { kind: "floating", label: "div.ghost", rect: { x: 0, y: 0, w: 100, h: 10 }, opaque: false },
    ]);
    expect(issues).toEqual([{ kind: "covers", over: "div.bn-toolbar", under: "paragraph #b1", area: 0.5 }]);
  });
});

describe("Wiedergabe-Plan", () => {
  it("Tasten, Kürzel, IME, Einfügen und Mausauswahl ab dem Zwischenstand", () => {
    const b = buildBugBundle(input([
      { t: 0, kind: "key", root: "p1", key: "q", mods: {} }, // vor dem Zwischenstand: nicht dabei
      ...events(),
      { t: 9, kind: "key", root: "p1", key: "Shift", mods: { shift: true } },
      { t: 10, kind: "key", root: "p1", key: "Enter", mods: {} },
      { t: 11, kind: "key", root: "p1", key: "v", mods: { meta: true } },
      { t: 12, kind: "select", root: "p1", sel: { type: "text", anchor: 1, head: 5 }, cause: "pointer" },
      { t: 13, kind: "key", root: "other", key: "z", mods: {} },
      { t: 14, kind: "key", root: "p1", key: "ArrowUp", mods: { meta: true, shift: true } },
    ]));
    const plan = replayPlan(b);
    expect(plan.root).toBe("p1");
    expect(plan.actions).toEqual([
      { kind: "type", text: "X" },
      { kind: "press", combo: "ControlOrMeta+b" },
      { kind: "insertText", text: "xx" },
      { kind: "paste", plain: "Xxxxxxxx Xxxxxxxx xxxx Xxx", html: `<p class="x" data-href="Xxxxxxxx Xxxxxxxx xxxx Xxx">Xxxxxxxx Xxxxxxxx xxxx Xxx</p>` },
      { kind: "press", combo: "Enter" },
      { kind: "select", sel: { type: "text", anchor: 1, head: 5 } },
      { kind: "press", combo: "ControlOrMeta+Shift+ArrowUp" },
    ]);
    expect(plan.expected).toBeDefined();
    expect(replayPlan(b, { mode: "steps" }).actions).toHaveLength(1);
  });

  it("ohne Zwischenstand: klare Meldung", () => {
    expect(() => replayPlan(buildBugBundle(input([{ t: 1, kind: "key", key: "a", mods: {} }])))).toThrow(/starting point/);
  });

  it("comboFor und normalizeDoc", () => {
    expect(comboFor(" ", {})).toBe("Space");
    expect(comboFor("B", { ctrl: true, shift: true })).toBe("ControlOrMeta+Shift+b");
    expect(normalizeDoc(doc("a"))).not.toHaveProperty("content.0.content.0.attrs.id");
  });
});
