// BSD-418: Hänger-Analyse im Kern – Schwellen, Ringpuffer, Breadcrumbs ohne Inhalte, Statistik, Ursache aus langen
// Frames, Persistenz (auch alte/fehlende Daten), Watchdog mit falscher Uhr, Absturzbericht mit laufendem Hänger.
import { describe, expect, it } from "vitest";
import {
  appendToSession, BreadcrumbTrail, buildBugBundle, buildCrashReport, crashKind, crashReportSummary, deadMarkers, formatHangMs, HANG_STORE_KEY, hangLine, HangMonitor,
  hangReportLines, hangStats, HangWatchdog, loafCulprit, markerHang, ongoingHangNotice, parseBugBundle, parseHangMarker, parseHangStore, shouldOfferCrashReport,
  storeSession, type HangMarker, type HangRecord, type WatchdogEvent,
} from "../src/index.js";

const T0 = Date.UTC(2026, 10, 14, 9, 0, 0);

function monitor(o: { noAttribution?: string } = {}) {
  let now = T0;
  let activity = "route home";
  const crumbs = new BreadcrumbTrail(20, () => now);
  const m = new HangMonitor({ now: () => now, activity: () => activity, crumbs, ...o });
  return { m, crumbs, advance: (ms: number) => { now += ms; }, setActivity: (a: string) => { activity = a; } };
}

describe("Hänger (BSD-418)", () => {
  it("Schwellen je Quelle: Hauptthread ab 250 ms, Eingaben ab 200 ms, Store ab 1 s", () => {
    const { m } = monitor();
    expect(m.record({ ms: 249, source: "main" })).toBeUndefined();
    expect(m.record({ ms: 250, source: "main" })?.ms).toBe(250);
    expect(m.record({ ms: 199, source: "input" })).toBeUndefined();
    expect(m.record({ ms: 640, source: "input", culprit: "click on sidebar-new-page" })?.culprit).toBe("click on sidebar-new-page");
    expect(m.record({ ms: 999, source: "worker" })).toBeUndefined();
    expect(m.record({ ms: 1200, source: "worker", culprit: "command createPage" })?.source).toBe("worker");
    expect(m.all).toHaveLength(3);
    const custom = new HangMonitor({ thresholds: { main: 100 } });
    expect(custom.record({ ms: 120, source: "main" })).toBeDefined();
  });

  it("Datensatz: Beginn, Aktivität und die letzten Breadcrumbs im Moment des Hängers", () => {
    const { m, crumbs, advance, setActivity } = monitor();
    crumbs.add("route page");
    crumbs.add("click sidebar-row");
    crumbs.add("click sidebar-row");
    setActivity("route page");
    advance(5000);
    const h = m.record({ ms: 800, source: "main" })!;
    expect(h).toEqual({ at: T0 + 5000 - 800, ms: 800, activity: "route page", breadcrumbs: ["route page", "click sidebar-row ×2"], source: "main" });
    crumbs.add("shortcut quickFind");
    expect(h.breadcrumbs).toHaveLength(2); // Momentaufnahme, nicht live
  });

  it("Ringpuffer: höchstens 200 Hänger, die ältesten fallen heraus", () => {
    const { m } = monitor();
    for (let i = 0; i < 230; i++) m.record({ ms: 300 + i, source: "main" });
    expect(m.all).toHaveLength(200);
    expect(m.all[0]!.ms).toBe(330);
  });

  it("Breadcrumbs: höchstens 20, Wiederholungen zusammengefasst, keine Inhalte (redact, Länge)", () => {
    const t = new BreadcrumbTrail();
    for (let i = 0; i < 25; i++) t.add(`click row-${i}`);
    expect(t.list()).toHaveLength(20);
    expect(t.list()[0]).toBe("click row-5");
    t.add(`click “Geheimes Tagebuch” for ada@example.com`);
    t.add("x".repeat(500));
    const [secret, long] = t.list().slice(-2);
    expect(secret).not.toMatch(/Geheimes|ada@/);
    expect(long!.length).toBeLessThanOrEqual(60);
    t.add("  ");
    expect(t.list()).toHaveLength(20);
  });

  it("Statistik je Sitzung: Anzahl, blockierte Zeit, p50/p95/max, Freezes ab 2 s", () => {
    const hangs: HangRecord[] = [300, 400, 500, 600, 2500].map((ms, i) => ({ at: T0 + i, ms, activity: "", breadcrumbs: [], source: "main" }));
    hangs.push({ at: T0, ms: 3000, activity: "", breadcrumbs: [], source: "worker" });
    const s = hangStats(hangs);
    expect(s).toEqual({ count: 6, main: 5, input: 0, worker: 1, blockedMs: 4300, p50: 500, p95: 2500, max: 2500, freezes: 1 });
    expect(hangStats([])).toMatchObject({ count: 0, blockedMs: 0, p50: 0, max: 0 });
    expect(formatHangMs(640)).toBe("640 ms");
    expect(formatHangMs(3040)).toBe("3.0 s");
  });

  it("Lange Frames liefern Ursache und genaue Dauer – in beiden Reihenfolgen; ohne Frames: „keine Zuordnung“", () => {
    const { m } = monitor({ noAttribution: "no attribution (WebKit)" });
    // Zeitgeber zuerst (misst zu kurz), Frame danach
    const a = m.record({ ms: 260, source: "main", start: 1000 })!;
    expect(a.culprit).toBe("no attribution (WebKit)");
    m.noteFrame({ start: 990, duration: 305, culprit: loafCulprit([{ sourceFunctionName: "busyLoop", sourceURL: "http://localhost:4174/src/shell/hangs.ts?t=123", sourceCharPosition: 812, invoker: "TimerHandler:setTimeout", invokerType: "user-callback", duration: 300 }]) });
    expect(m.all.at(-1)).toMatchObject({ ms: 305, culprit: "busyLoop (hangs.ts:812) · user-callback:TimerHandler:setTimeout" });
    // Frame zuerst
    m.noteFrame({ start: 5000, duration: 1010, culprit: "render (App.tsx:10)" });
    expect(m.record({ ms: 980, source: "main", start: 5020 })).toMatchObject({ ms: 1010, culprit: "render (App.tsx:10)" });
    // fremder Frame ändert nichts
    m.noteFrame({ start: 9000, duration: 80, culprit: "other" });
    expect(m.all.map((h) => h.culprit)).toEqual(["busyLoop (hangs.ts:812) · user-callback:TimerHandler:setTimeout", "render (App.tsx:10)"]);
    expect(loafCulprit([])).toBeUndefined();
    expect(loafCulprit([{ duration: 5 }])).toBe("anonymous");
  });

  it("Langsame Eingabe zählt nicht doppelt, wenn sie in einen Hauptthread-Hänger fällt; Store-Zeit ohne blockierten Hauptthread", () => {
    const { m } = monitor();
    m.record({ ms: 600, source: "main", start: 2000 });
    expect(m.noteInput({ start: 1990, duration: 640, name: "click on page-menu" })).toBeUndefined();
    expect(m.noteInput({ start: 4000, duration: 230, name: "keydown in textbox" })?.source).toBe("input");
    expect(m.blockedBetween(1500, 3000)).toBe(600);
    expect(m.blockedBetween(2300, 2400)).toBe(100);
    expect(m.blockedBetween(3000, 3500)).toBe(0);
  });

  it("Persistenz: Versionsfeld, fehlende/kaputte/fremde Daten, altes Format ohne Versionsfeld und ohne `source`", () => {
    expect(HANG_STORE_KEY).toBe("based.diagnostics.hangs");
    expect(parseHangStore(null).sessions).toEqual([]);
    expect(parseHangStore("{kaputt").sessions).toEqual([]);
    expect(parseHangStore(JSON.stringify({ v: 99, sessions: [{ id: "x" }] })).sessions).toEqual([]);
    // Format 0: nur eine Liste, Einträge ohne `source`/`breadcrumbs`
    const legacy = parseHangStore(JSON.stringify([{ at: T0, ms: 2600, activity: "boot phase store ready" }, { at: "nope" }]));
    expect(legacy.sessions).toHaveLength(1);
    expect(legacy.sessions[0]!.hangs[0]).toEqual({ at: T0, ms: 2600, activity: "boot phase store ready", breadcrumbs: [], source: "main" });
    expect(legacy.sessions[0]!.stats.freezes).toBe(1);

    const { m } = monitor();
    m.record({ ms: 700, source: "main", culprit: "x" });
    let data = storeSession(parseHangStore(null), { id: "s1", startedAt: T0, hangs: m.all });
    for (let i = 2; i <= 6; i++) data = storeSession(data, { id: `s${i}`, startedAt: T0 + i, hangs: [] });
    expect(data.sessions.map((s) => s.id)).toEqual(["s3", "s4", "s5", "s6"]);
    const round = parseHangStore(JSON.stringify(storeSession(data, { id: "s6", startedAt: T0 + 6, hangs: m.all })));
    expect(round.v).toBe(1);
    expect(round.sessions.at(-1)!.hangs[0]).toMatchObject({ ms: 700, culprit: "x", source: "main" });
    // ein Eintrag ohne Kennzahlen bekommt sie aus den Hängern
    const noStats = parseHangStore(JSON.stringify({ v: 1, sessions: [{ id: "a", startedAt: T0, hangs: [{ at: T0, ms: 300, source: "input", activity: "", breadcrumbs: [] }] }] }));
    expect(noStats.sessions[0]!.stats).toMatchObject({ count: 1, input: 1 });
  });

  it("Watchdog (falsche Uhr): Marker erst nach 2 s ohne Antwort, jede Sekunde neu, gelöscht beim Antworten", () => {
    let t = 0;
    const sent: WatchdogEvent[] = [];
    const markers: HangMarker[] = [];
    const cleared: string[] = [];
    const w = new HangWatchdog({ now: () => t, epoch: () => T0 + t, send: (e) => sent.push(e), writeMarker: (m) => markers.push(m), clearMarker: (s) => cleared.push(s) });
    w.tick();
    expect(sent).toHaveLength(0); // noch nicht gestartet
    w.handle({ type: "start", session: "tab-1" });
    w.handle({ type: "context", activity: "route page", breadcrumbs: ["click hang-300", "shortcut quickFind"] });
    w.tick();
    expect(sent).toEqual([{ type: "ping", id: 1 }]);
    w.handle({ type: "pong", id: 1 });
    t = 500; w.tick();
    expect(sent.at(-1)).toEqual({ type: "ping", id: 2 });
    for (t = 1000; t < 2500; t += 500) w.tick();
    expect(markers).toHaveLength(0);
    t = 2500; w.tick();
    expect(markers).toEqual([{ v: 1, session: "tab-1", startedAt: T0 + 500, ms: 2000, updatedAt: T0 + 2500, activity: "route page", breadcrumbs: ["click hang-300", "shortcut quickFind"] }]);
    t = 3000; w.tick();
    expect(markers).toHaveLength(1);
    t = 3500; w.tick();
    expect(markers.at(-1)!.ms).toBe(3000);
    w.handle({ type: "pong", id: 1 }); // alte Antwort zählt nicht
    expect(cleared).toEqual([]);
    t = 3600; w.handle({ type: "pong", id: 2 });
    expect(sent.at(-1)).toEqual({ type: "recovered", ms: 3100 });
    expect(cleared).toEqual(["tab-1"]);
    // verborgen: kein Ping
    w.handle({ type: "pause" });
    const n = sent.length;
    t = 9000; w.tick();
    expect(sent).toHaveLength(n);
  });

  it("Marker: lesen, tote erkennen (Neuladen dieses Tabs, veraltet), frische eines anderen Tabs nicht", () => {
    const m = parseHangMarker({ v: 1, session: "old", startedAt: T0, ms: 3200, updatedAt: T0 + 3200, activity: "route page", breadcrumbs: ["click hang-3000", 4] })!;
    expect(m.breadcrumbs).toEqual(["click hang-3000"]);
    expect(parseHangMarker({ v: 2, session: "x", startedAt: 1, ms: 1 })).toBeUndefined();
    expect(parseHangMarker(null)).toBeUndefined();
    const other = { ...m, session: "other" };
    expect(deadMarkers([m, other], { mine: "new", previous: "old", now: T0 + 4000 }).map((x) => x.session)).toEqual(["old"]);
    expect(deadMarkers([m, other], { mine: "new", now: T0 + 60_000 }).map((x) => x.session)).toEqual(["old", "other"]);
    expect(markerHang(m)).toMatchObject({ ms: 3200, ongoing: true, source: "main", activity: "route page" });
    expect(ongoingHangNotice(m)).toBe("Based hung for more than 3 s during route page and was then closed or reloaded.");
    expect(hangLine(markerHang(m))).toContain("3.2 s+ (still blocked at the end) · main · during route page · after click hang-3000");
    const data = appendToSession(storeSession(parseHangStore(null), { id: "old", startedAt: T0 - 1000, hangs: [] }), "old", markerHang(m));
    expect(data.sessions[0]).toMatchObject({ id: "old", startedAt: T0 - 1000, stats: { count: 1, freezes: 1, max: 3200 } });
  });

  it("Absturzbericht nach einem laufenden Hänger; alte Sitzungen und Berichte ohne Hänger-Felder bleiben lesbar", () => {
    const prev = { startedAt: T0, lastBeat: T0 + 60_000, clean: true, stalls: 0 };
    const marker = parseHangMarker({ v: 1, session: "old", startedAt: T0 + 50_000, ms: 4100, updatedAt: T0 + 54_100, activity: "route page", breadcrumbs: ["click hang-3000"] })!;
    expect(crashKind(prev)).toBeUndefined();
    expect(crashKind(prev, marker)).toBe("hang");
    expect(shouldOfferCrashReport(prev, true, undefined, marker)).toBe(true);
    const r = buildCrashReport({ prev, app: { shell: "web", platform: "Linux" }, now: T0 + 70_000, ongoing: marker,
      hangs: { id: "old", startedAt: T0, stats: hangStats([markerHang(marker)]), hangs: [markerHang(marker)] } })!;
    expect(r.kind).toBe("hang");
    expect(r.hang).toEqual({ startedAt: new Date(T0 + 50_000).toISOString(), ms: 4100, activity: "route page", breadcrumbs: ["click hang-3000"] });
    expect(r.hangs?.lines[0]).toContain("4.1 s+");
    expect(crashReportSummary(r)).toContain("hung 4 s+ during route page");
    // alte Sitzung (ohne Hänger) wie bisher
    const old = buildCrashReport({ prev: { ...prev, clean: false }, app: { shell: "web", platform: "Linux" }, now: T0 })!;
    expect(old.kind).toBe("crash");
    expect("hang" in old || "hangs" in old).toBe(false);
    // altes Bündel (ohne `hangs`) wird gelesen; neues trägt sie
    const base = { id: "b", now: T0, note: "", realText: false, app: { shell: "web" }, env: { width: 1, height: 1, dpr: 1, zoom: 1, theme: "light" }, state: { menus: [] }, layout: [], events: [], log: [] };
    const oldBundle = JSON.parse(JSON.stringify(buildBugBundle(base))) as Record<string, unknown>;
    expect(parseBugBundle(oldBundle)?.hangs).toBeUndefined();
    const withHangs = buildBugBundle({ ...base, hangs: { stats: hangStats([]), hangs: [], previous: [] } });
    expect(parseBugBundle(JSON.parse(JSON.stringify(withHangs)))?.hangs?.stats.count).toBe(0);
  });

  it("Berichtszeilen: diese Sitzung und frühere", () => {
    const { m, crumbs } = monitor();
    crumbs.add("click hang-1000");
    m.record({ ms: 1000, source: "main", culprit: "busyLoop" });
    const lines = hangReportLines(m.all, [{ id: "p", startedAt: T0 - 86_400_000, stats: hangStats([]), hangs: [] }]);
    expect(lines[0]).toBe("hangs this session: 1 hang (main 1, input 0, store 0) · blocked 1.0 s · p50 1.0 s · p95 1.0 s · max 1.0 s");
    expect(lines[1]).toContain("1.0 s · main · during route home · in busyLoop · after click hang-1000");
    expect(lines[2]).toContain("no hangs");
  });
});
