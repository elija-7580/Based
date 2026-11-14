// BSD-418: Hänger-Erkennung der Web-Hülle (Gegenstück zu legacy/App/Shared/Diagnostics/HangWatchdog.swift). Dünn:
// misst und meldet an HangMonitor (packages/core/src/hangs.ts).
// - Hauptthread: setTimeout-Kette im Takt von 50 ms, monoton (performance.now), nur bei sichtbarer Seite (verborgen und
//   Ruhezustand zählen nicht, BSD-331). Kein rAF-Dauerlauf.
// - Ursache: Long Animation Frames (Chromium/WebView2: Skript, Funktion, Auslöser), sonst Long Tasks; WebKit nennt keine.
// - Langsame Eingaben: Event Timing (wo es das gibt), nur Ereignisname und Ziel (data-testid/Rolle) – nie Text.
// - Laufender Hänger: ein Watchdog-Worker pingt; > 2 s ohne Antwort → Marker in IndexedDB; der nächste Start zeigt ihn.
// - Store: Anfragen an den Worker über 1 s (Operationsname, ohne Inhalte), abzüglich der Zeit, in der der Hauptthread hing.
// - Breadcrumbs: Route, Tastenkürzel, Klickziel, Slash-Befehl (noteBreadcrumb aus dem Kern).
import {
  appendToSession, BreadcrumbTrail, deadMarkers, formatHangMs, FREEZE_MS, HANG_MARKER_GRACE_MS, HANG_MARKER_VERSION, HANG_STORE_KEY, hangReport, hangReportLines, HangMonitor, loafCulprit, markerHang,
  ongoingHangNotice, parseHangMarker, parseHangStore, setBreadcrumbSink, storeSession, type HangMarker, type HangRecord, type HangReport, type HangSessionData, type LoAFScript,
  type WatchdogEvent, type WatchdogMessage,
} from "@based/core/hangs";
import { addReportSection, currentActivity, diagnosticsLog, noteFreeze, onActivity } from "./diagnostics.js";
import { readMarkers, removeMarker } from "./hangMarkers.js";
import { matchShortcut } from "./shortcuts.js";

const TICK_MS = 50;
const TAB_KEY = "based.diagnostics.tab";

const ls = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };
const ss = (): Storage | undefined => { try { return globalThis.sessionStorage; } catch { return undefined; } };
const perfNow = () => globalThis.performance.now();

function newSessionID(): string {
  try { return globalThis.crypto.randomUUID(); } catch { return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
}

type Attribution = "loaf" | "longtask" | "none";
function attribution(): Attribution {
  const types = (globalThis.PerformanceObserver as { supportedEntryTypes?: readonly string[] } | undefined)?.supportedEntryTypes ?? [];
  return types.includes("long-animation-frame") ? "loaf" : types.includes("longtask") ? "longtask" : "none";
}
const isWebKit = () => /AppleWebKit/.test(globalThis.navigator?.userAgent ?? "") && !/Chrome|Chromium|Edg\//.test(globalThis.navigator?.userAgent ?? "");
function noAttributionText(a: Attribution): string | undefined {
  if (a === "loaf") return undefined;
  if (a === "longtask") return "no script details (Long Tasks only)";
  return isWebKit() ? "no attribution (WebKit)" : "no attribution (this browser)";
}

export const breadcrumbs = new BreadcrumbTrail();
const supported = attribution();
export const hangMonitor = new HangMonitor({ activity: currentActivity, crumbs: breadcrumbs, ...(noAttributionText(supported) ? { noAttribution: noAttributionText(supported)! } : {}) });
/** Wie die Hülle Ursachen erfährt (für die Anzeige). */
export const hangAttribution = supported;
/** Ein fester Name in die Breadcrumbs (nie Inhalte). */
export const breadcrumb = (name: string) => breadcrumbs.add(name);

// MARK: Sitzungen und Hänger am Ende der vorigen

const sessionID = newSessionID();
const sessionStarted = Date.now();
let previousTab: string | undefined;
let previousSessions: HangSessionData[] = [];
let endedInHang: { marker: HangMarker; session: HangSessionData | undefined } | undefined;
const listeners = new Set<() => void>();
let snap = { previous: previousSessions, endedInHang };
const emit = () => { snap = { previous: previousSessions, endedInHang }; for (const l of listeners) l(); };

/** Für React: frühere Sitzungen und der Hänger, mit dem die vorige Sitzung endete. */
export const hangHistory = {
  subscribe: (fn: () => void) => { listeners.add(fn); return () => void listeners.delete(fn); },
  get: () => snap,
};

/** Der Hänger, in dem die vorige Sitzung endete (Marker des Watchdog-Workers), samt den Hängern dieser Sitzung. */
export const previousHang = () => endedInHang;

function readStore() { return parseHangStore(ls()?.getItem(HANG_STORE_KEY)); }
function writeStore(data: ReturnType<typeof readStore>) { try { ls()?.setItem(HANG_STORE_KEY, JSON.stringify(data)); } catch { /* voll oder gesperrt */ } }

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistSoon() {
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => { persistTimer = undefined; persist(); }, 1000);
}
function persist() {
  writeStore(storeSession(readStore(), { id: sessionID, startedAt: sessionStarted, hangs: hangMonitor.all }));
}

/** Marker toter Sitzungen übernehmen: Hinweis im Log, Hänger an die Sitzung hängen, Marker löschen. */
async function adoptMarkers(retries = 3) {
  const all = await readMarkers(sessionID);
  const dead = deadMarkers(all, { mine: sessionID, previous: previousTab, now: Date.now() });
  // vom Hauptthread beim Verlassen geschrieben (pagehide kurz nach einem Freeze): die Sitzung ist sicher vorbei
  const left = takeLeftInHang();
  const bySession = new Map<string, HangMarker>();
  for (const m of [...dead, ...(left ? [left] : [])]) {
    const cur = bySession.get(m.session);
    // der Marker, der „lief noch“ sagt, gewinnt; sonst der längere
    if (!cur || (cur.recovered && !m.recovered) || (!!cur.recovered === !!m.recovered && m.ms > cur.ms)) bySession.set(m.session, m);
  }
  const markers = [...bySession.values()];
  // Frischer Marker eines anderen Tabs: hängt der gerade, oder wurde er eben beendet? Später noch einmal ansehen.
  if (retries > 0 && all.some((m) => m.session !== sessionID && !dead.includes(m))) setTimeout(() => void adoptMarkers(retries - 1).catch(() => undefined), 5000);
  if (!markers.length) return;
  let data = readStore();
  for (const [i, raw] of markers.entries()) {
    // Hat die Sitzung den Hänger nach seinem Ende noch selbst gemessen, gilt ihre (genauere) Dauer.
    const own = raw.recovered ? data.sessions.find((x) => x.id === raw.session)?.hangs.find((h) => h.source === "main" && h.at <= raw.startedAt + raw.ms && raw.startedAt <= h.at + h.ms) : undefined;
    const m = own ? { ...raw, startedAt: own.at, ms: Math.max(raw.ms, own.ms) } : raw;
    markers[i] = m;
    data = appendToSession(data, m.session, markerHang(m));
    diagnosticsLog.add("warning", `previous session ended in a hang: ${ongoingHangNotice(m)}${m.breadcrumbs.length ? ` Steps before: ${m.breadcrumbs.join(" › ")}` : ""}`);
    void removeMarker(m.session);
  }
  writeStore(data);
  previousSessions = data.sessions.filter((s) => s.id !== sessionID);
  const last = markers.sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
  endedInHang = { marker: last, session: data.sessions.find((s) => s.id === last.session) };
  emit();
}

// MARK: Meldungen

function logHang(h: HangRecord) {
  const level = h.ms >= 1000 ? "warning" : "info";
  const where = `${h.activity ? `during ${h.activity}` : ""}${h.culprit ? `${h.activity ? ", " : ""}in ${h.culprit}` : ""}`;
  const crumbs = h.breadcrumbs.length ? ` after ${h.breadcrumbs.slice(-3).join(" › ")}` : "";
  const head = h.source === "main" ? `main thread blocked for ${h.ms} ms` : h.source === "input" ? `slow input ${formatHangMs(h.ms)}` : `slow store request ${formatHangMs(h.ms)}`;
  diagnosticsLog.add(level, `${head}${where ? ` (${where})` : ""}${crumbs}`);
}

// MARK: Verlassen kurz nach einem Freeze (WebKit)

/**
 * WebKit leitet Speicherzugriffe aus Workern (IndexedDB, OPFS) über den Hauptthread – der Watchdog-Worker kann dort
 * während eines Hängers nichts festhalten. Neuladen/Schließen wartet aber, bis der Hauptthread frei ist; dann läuft
 * pagehide: Endete gerade ein Freeze, schreibt der Hauptthread selbst den Marker (localStorage, synchron).
 */
const LEFT_KEY = "based.diagnostics.leftInHang";
let lastFreeze: { rec: HangRecord; endedAt: number } | undefined;

function noteLeaving() {
  if (!lastFreeze || perfNow() - lastFreeze.endedAt > HANG_MARKER_GRACE_MS) return;
  const { rec } = lastFreeze;
  const m: HangMarker = { v: HANG_MARKER_VERSION, session: sessionID, startedAt: rec.at, ms: rec.ms, updatedAt: Date.now(), activity: rec.activity, breadcrumbs: rec.breadcrumbs, recovered: true };
  try { ls()?.setItem(LEFT_KEY, JSON.stringify(m)); } catch { /* gesperrt */ }
}

function takeLeftInHang(): HangMarker | undefined {
  const raw = ls()?.getItem(LEFT_KEY);
  if (!raw) return undefined;
  let m: HangMarker | undefined;
  try { m = parseHangMarker(JSON.parse(raw)); } catch { /* kaputt */ }
  if (m?.session === sessionID) return undefined;
  try { ls()?.removeItem(LEFT_KEY); } catch { /* gesperrt */ }
  return m;
}

function onRecorded(h: HangRecord | undefined) {
  if (!h) return;
  if (h.source === "main" && h.ms >= FREEZE_MS) {
    noteFreeze();
    lastFreeze = { rec: h, endedAt: perfNow() };
  }
  // kurz warten: der lange Frame (Ursache, genaue Dauer) kommt nach dem Zeitgeber
  setTimeout(() => logHang(h), 300);
  persistSoon();
}

/** Store-Anfrage beantwortet (aus StoreClient): über 1 s → Hänger „worker“ mit Operationsnamen. */
export function noteStoreRequest(op: string, t0: number, t1: number) {
  const ms = t1 - t0 - hangMonitor.blockedBetween(t0, t1);
  if (ms < hangMonitor.thresholds.worker) return;
  onRecorded(hangMonitor.record({ ms, source: "worker", culprit: `store ${op}` }));
}

/** Ziel als fester Name: data-testid, sonst Rolle bzw. Elementart. Nie Text. */
export function describeTarget(node: EventTarget | Node | null | undefined): string {
  const el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  if (!el) return "page";
  const tid = el.closest("[data-testid]")?.getAttribute("data-testid");
  const roleEl = el.closest("[role]");
  const role = roleEl?.getAttribute("role");
  const editable = el.closest("[contenteditable=true], [contenteditable='']");
  const tag = el.tagName.toLowerCase();
  const kind = editable ? "editor" : role ?? (tag === "input" || tag === "textarea" ? "textbox" : tag === "a" ? "link" : tag);
  // Kennungen mit Datensatz-IDs (z. B. „row-<uuid>“) kürzen: der Bereich zählt, nicht die Zeile.
  const id = tid?.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "‹id›").replace(/\b[0-9A-F]{20,}\b/g, "‹id›");
  return id ? `${id}${role && !id.includes(role) ? ` (${role})` : ""}` : kind;
}

// MARK: Messung

interface Overhead { ticks: number; busyMs: number; since: number }
const overhead: Overhead = { ticks: 0, busyMs: 0, since: 0 };

let installed = false;
let worker: Worker | undefined;
const toWorker = (m: WatchdogMessage) => { try { worker?.postMessage(m); } catch { /* Worker weg */ } };

/** Einmal beim Start (main.tsx), nach installDiagnostics. */
export function installHangMonitor(win: Window & typeof globalThis = globalThis as Window & typeof globalThis) {
  if (installed) return;
  installed = true;
  overhead.since = perfNow();
  const tab = ss();
  previousTab = tab?.getItem(TAB_KEY) ?? undefined;
  try { tab?.setItem(TAB_KEY, sessionID); } catch { /* gesperrt */ }
  previousSessions = readStore().sessions.filter((s) => s.id !== sessionID);
  emit();

  // Hauptthread: Zeitgeber-Kette, nur bei sichtbarer Seite
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = 0;
  let throttledRun = 0;
  const tick = () => {
    const t = perfNow();
    const late = t - last - TICK_MS;
    last = t;
    // WebKit/macOS drosselt Zeitgeber im Hintergrund (anderes Fenster vorn, App Nap) auf ~1 s, ohne dass die Seite
    // „hidden“ wird. Das sah aus wie Hänger von ~950 ms im Sekundentakt. Darum: ohne Fokus nicht messen, und eine
    // Folge von Verspätungen genau im Sekundenraster gilt als Drosselung, nicht als Hänger.
    const onGrid = Math.abs(late + TICK_MS - 1000) <= 25;
    throttledRun = onGrid ? throttledRun + 1 : 0;
    if (late >= hangMonitor.thresholds.main && focused() && throttledRun < 2) onRecorded(hangMonitor.record({ ms: late, source: "main", start: t - late }));
    overhead.ticks += 1;
    timer = setTimeout(tick, TICK_MS);
    overhead.busyMs += perfNow() - t;
  };
  const visible = () => win.document.visibilityState === "visible";
  const focused = () => { try { return win.document.hasFocus(); } catch { return true; } };
  const watch = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    throttledRun = 0;
    if (visible() && focused()) {
      last = perfNow();
      timer = setTimeout(tick, TICK_MS);
      toWorker({ type: "resume" });
    } else {
      toWorker({ type: "pause" });
      persist();
    }
  };

  // Ursache: lange Frames; langsame Eingaben
  try {
    if (supported === "loaf") {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as (PerformanceEntry & { scripts?: LoAFScript[] })[]) {
          if (e.duration < 200) continue;
          const culprit = loafCulprit(e.scripts);
          hangMonitor.noteFrame({ start: e.startTime, duration: e.duration, ...(culprit ? { culprit } : {}) });
        }
      }).observe({ type: "long-animation-frame", buffered: true });
    } else if (supported === "longtask") {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.duration >= 200) hangMonitor.noteFrame({ start: e.startTime, duration: e.duration });
      }).observe({ type: "longtask", buffered: true });
    }
  } catch { /* Beobachter nicht verfügbar */ }
  try {
    const types = (globalThis.PerformanceObserver as { supportedEntryTypes?: readonly string[] } | undefined)?.supportedEntryTypes ?? [];
    if (types.includes("event")) {
      new PerformanceObserver((list) => {
        // je Interaktion (pointerdown, pointerup, click) nur der längste Eintrag
        type EventEntry = PerformanceEventTiming & { interactionId?: number };
        const byInteraction = new Map<number | string, EventEntry>();
        for (const e of list.getEntries() as EventEntry[]) {
          const key = e.interactionId || `${e.name}@${Math.round(e.startTime)}`;
          const cur = byInteraction.get(key);
          if (!cur || e.duration > cur.duration) byInteraction.set(key, e);
        }
        for (const e of byInteraction.values()) {
          if (!visible()) continue;
          const key = e.name.startsWith("key") ? "in" : "on";
          onRecorded(hangMonitor.noteInput({ start: e.startTime, duration: e.duration, name: `${e.name} ${key} ${describeTarget(e.target)}` }));
        }
      }).observe({ type: "event", durationThreshold: 104, buffered: false } as PerformanceObserverInit);
    }
  } catch { /* Event Timing nicht verfügbar */ }

  // Breadcrumbs: Route/Ansicht, Tastenkürzel, Klickziel, Escape; Slash-Befehle über noteBreadcrumb (Kern)
  setBreadcrumbSink(breadcrumb);
  onActivity((name) => breadcrumb(name));
  win.addEventListener("click", (e) => breadcrumb(`click ${describeTarget(e.target)}`), { capture: true, passive: true });
  win.addEventListener("contextmenu", (e) => breadcrumb(`context menu ${describeTarget(e.target)}`), { capture: true, passive: true });
  win.addEventListener("keydown", (e) => {
    const a = matchShortcut(e);
    if (a) breadcrumb(`shortcut ${a.kind}`);
    else if (e.key === "Escape") breadcrumb("key Escape");
  }, { capture: true, passive: true });

  // Watchdog-Worker: laufender Hänger überlebt Neuladen/Beenden
  try {
    worker = new Worker(new URL("./hangWatchdog.worker.ts", import.meta.url), { type: "module", name: "based-hang-watchdog" });
    worker.onmessage = (e: MessageEvent<WatchdogEvent>) => {
      const m = e.data;
      if (m.type === "ping") toWorker({ type: "pong", id: m.id });
      // Hänger über 2 s vorbei: sofort speichern; Marker erst nach der Gnadenfrist löschen (Neuladen wegen des Hängers)
      if (m.type === "recovered") {
        persist();
        setTimeout(() => toWorker({ type: "clear" }), HANG_MARKER_GRACE_MS);
      }
    };
    toWorker({ type: "start", session: sessionID });
    const sendContext = () => toWorker({ type: "context", activity: currentActivity(), breadcrumbs: breadcrumbs.list(10) });
    sendContext();
    breadcrumbs.onChange(sendContext);
    onActivity(sendContext);
  } catch { /* ohne Worker kein Marker */ }

  watch();
  win.document.addEventListener("visibilitychange", watch);
  win.addEventListener("focus", watch);
  win.addEventListener("blur", watch);
  win.addEventListener("pagehide", () => { persist(); noteLeaving(); });
  void adoptMarkers().catch(() => undefined);
  addReportSection(() => hangReportLines(hangMonitor.all, previousSessions));
  exposeTestHooks();
}

/** Für Bündel (Problem melden). */
export const hangBundle = (): HangReport => hangReport(hangMonitor.all, previousSessions);

// MARK: Test-Haken (nur Dev-Build oder automatisierter Browser)

export interface HangTestHooks {
  /** Hauptthread `ms` lang blockieren (nach `delay` ms, damit evaluate zurückkommt). */
  hang(ms: number, delay?: number): void;
  hangs(): readonly HangRecord[];
  overhead(): { ticks: number; busyMs: number; elapsedMs: number };
  session(): string;
}

function exposeTestHooks() {
  const automated = (globalThis.navigator as Navigator & { webdriver?: boolean } | undefined)?.webdriver === true;
  if (!import.meta.env.DEV && !automated) return;
  const hooks: HangTestHooks = {
    hang: (ms, delay = 20) => {
      setTimeout(function busyLoop() {
        breadcrumb(`test hang ${ms}`);
        const end = perfNow() + ms;
        while (perfNow() < end) { /* absichtlich blockieren */ }
      }, delay);
    },
    hangs: () => hangMonitor.all,
    overhead: () => ({ ticks: overhead.ticks, busyMs: Math.round(overhead.busyMs * 100) / 100, elapsedMs: Math.round(perfNow() - overhead.since) }),
    session: () => sessionID,
  };
  const g = globalThis as { __basedTest?: Record<string, unknown> };
  g.__basedTest = { ...(g.__basedTest ?? {}), hangs: hooks };
}
