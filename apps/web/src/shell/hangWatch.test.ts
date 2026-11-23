// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-655: Der Watchdog-Worker läuft nur mit der Messkette (BSD-596) – im Leerlauf keine Nachrichten an ihn.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { WatchdogMessage } from "@based/core/hangs";

const posted: WatchdogMessage[] = [];
const workers: FakeWorker[] = [];
class FakeWorker {
  constructor() { workers.push(this); }
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage(m: WatchdogMessage) { posted.push(m); }
  /** Nachricht des Workers an die Hülle (z. B. ping). */
  emit(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
/** Monotone Uhr der Hülle: folgt der falschen Uhr; `skew` lässt einen Hänger ohne feuernde Zeitgeber vergehen. */
let skew = 0;
const base = Date.now();

function fakeWindow() {
  const win = new EventTarget() as EventTarget & { document: EventTarget & { visibilityState: string; hasFocus(): boolean } };
  const doc = new EventTarget() as EventTarget & { visibilityState: string; hasFocus(): boolean };
  doc.visibilityState = "visible";
  doc.hasFocus = () => true;
  win.document = doc;
  return win;
}

describe("Watchdog-Worker im Leerlauf (BSD-655)", () => {
  const win = fakeWindow();
  const types = () => posted.map((m) => m.type).filter((t) => t === "pause" || t === "resume" || t === "pong");

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"], now: base });
    vi.spyOn(globalThis.performance, "now").mockImplementation(() => Date.now() - base + 1000 + skew);
    vi.stubGlobal("Worker", FakeWorker);
    const { installHangMonitor } = await import("./hangs.js");
    installHangMonitor(win as unknown as Window & typeof globalThis);
  });
  afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("Start: resume, nach ACTIVE_MS ohne Anlass pause – danach keine Nachricht mehr", async () => {
    const { ACTIVE_MS } = await import("./hangs.js");
    expect(posted[0]).toMatchObject({ type: "start" });
    expect(types()).toEqual(["resume"]);
    vi.advanceTimersByTime(ACTIVE_MS + 200);
    expect(types()).toEqual(["resume", "pause"]);
    const n = posted.length;
    vi.advanceTimersByTime(10_000);
    expect(posted.slice(n).filter((m) => m.type !== "context")).toEqual([]);
  });

  it("Eingabe weckt Kette und Worker; Hänger direkt danach: Kette läuft weiter, pong kommt vor pause", async () => {
    const { ACTIVE_MS } = await import("./hangs.js");
    posted.length = 0;
    win.dispatchEvent(new Event("keydown"));
    expect(types()).toEqual(["resume"]);
    // weitere Eingaben, solange die Kette läuft: kein zweites resume
    win.dispatchEvent(new Event("pointermove"));
    expect(types()).toEqual(["resume"]);
    // Worker pingt; der Hauptthread hängt 3 s (die Uhr springt, ohne dass Zeitgeber feuern) – kein pause in der Zeit
    workers[0]!.emit({ type: "ping", id: 7 });
    expect(types()).toEqual(["resume", "pong"]);
    skew += 3000;
    vi.advanceTimersByTime(60); // der nächste Tick der Kette kommt 3 s zu spät
    // ein eben beendeter Hänger ist ein Anlass: noch kein pause, das pong auf das wartende ping geht zuerst
    expect(types()).toEqual(["resume", "pong"]);
    workers[0]!.emit({ type: "ping", id: 8 });
    expect(types()).toEqual(["resume", "pong", "pong"]);
    vi.advanceTimersByTime(ACTIVE_MS + 200);
    expect(types()).toEqual(["resume", "pong", "pong", "pause"]);
  });

  it("verborgen: pause; sichtbar und vorn: resume über wake", () => {
    posted.length = 0;
    win.document.visibilityState = "hidden";
    win.document.dispatchEvent(new Event("visibilitychange"));
    expect(types()).toEqual(["pause"]);
    win.document.visibilityState = "visible";
    win.document.dispatchEvent(new Event("visibilitychange"));
    expect(types()).toEqual(["pause", "resume"]);
  });
});
