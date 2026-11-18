// Feedback 18. 11.: Kleines Fenster „Meeting detected · Start transcribing“, wenn eine Meeting-App (Zoom, Teams, Meet
// im Browser …) das Mikrofon einschaltet – wie Notion. Nur in der Mac-App: die Hülle sagt über `mic_users`, welche
// Apps gerade über das Mikrofon aufnehmen (CoreAudio, ohne mitzuhören). Hier liegt nur die Entscheidung (rein,
// getestet) und das Nachfragen alle paar Sekunden; das Fenster selbst steht in meetingPrompt.tsx.
import { isTauri } from "../desktop.js";

/** Bundle-ID-Anfang → Name. Andere Apps (Diktat, Siri, Sprachmemos …) lösen nichts aus. */
const KNOWN: readonly (readonly [string, string])[] = [
  ["us.zoom", "Zoom"],
  ["com.microsoft.teams", "Microsoft Teams"],
  ["com.apple.facetime", "FaceTime"],
  ["com.tinyspeck.slackmacgap", "Slack"],
  ["com.cisco.webex", "Webex"],
  ["cisco-systems.spark", "Webex"],
  ["com.hnc.discord", "Discord"],
  ["com.skype", "Skype"],
  ["net.whatsapp.whatsapp", "WhatsApp"],
  ["desktop.whatsapp", "WhatsApp"],
  ["ru.keepcoder.telegram", "Telegram"],
  ["org.telegram", "Telegram"],
  ["com.google.chrome", "Chrome"],
  ["com.apple.safari", "Safari"],
  // Safari (und andere WebKit-Apps) nehmen über den GPU-Prozess von WebKit auf. Läuft Based selbst, fragt niemand.
  ["com.apple.webkit.gpu", "Safari"],
  ["org.mozilla.firefox", "Firefox"],
  ["com.microsoft.edgemac", "Edge"],
  ["com.brave.browser", "Brave"],
  ["company.thebrowser", "Arc"],
  ["com.vivaldi", "Vivaldi"],
  ["com.operasoftware", "Opera"],
];

/** Unbekannt, welche App (macOS vor 14.2): die Hülle meldet nur „Mikrofon läuft“. */
export const ANY_APP = "*";

/** Name der ersten erkannten Meeting-App, `ANY_APP` ohne App-Angabe, sonst `undefined`. */
export function meetingApp(bundleIDs: readonly string[]): string | undefined {
  for (const id of bundleIDs) {
    if (id === ANY_APP) return ANY_APP;
    const low = id.toLowerCase();
    const hit = KNOWN.find(([prefix]) => low.startsWith(prefix));
    if (hit) return hit[1];
  }
  return undefined;
}

export interface DetectState {
  /** Gerade angezeigt für diese App. */
  shown: string | undefined;
  /** Mit „Not now“ weggeklickt – bis diese App das Mikrofon wieder freigibt. */
  dismissed: ReadonlySet<string>;
  /** Wie oft hintereinander diese App gesehen wurde (ein kurzer Mikrofon-Test löst nichts aus). */
  seen: { app: string; count: number } | undefined;
}

export const DETECT_IDLE: DetectState = { shown: undefined, dismissed: new Set(), seen: undefined };
/** So oft hintereinander (je ein Nachsehen) muss die App aufnehmen, bevor gefragt wird. */
export const DETECT_AFTER = 2;

export type DetectAction = { kind: "show"; app: string } | { kind: "hide" } | undefined;

/** Ein Nachsehen: neuer Zustand und was mit dem Fenster passieren soll. */
export function detectStep(s: DetectState, input: { app: string | undefined; recording: boolean; enabled: boolean }): { state: DetectState; action: DetectAction } {
  const { app } = input;
  // Weggeklickte Apps gelten wieder, sobald sie das Mikrofon freigegeben haben.
  const dismissed = app !== undefined && s.dismissed.has(app) ? new Set([app]) : new Set<string>();
  const seen = app === undefined ? undefined : { app, count: s.seen?.app === app ? s.seen.count + 1 : 1 };
  const quiet = !input.enabled || input.recording || app === undefined || dismissed.has(app);
  if (quiet) return { state: { shown: undefined, dismissed, seen }, action: s.shown !== undefined ? { kind: "hide" } : undefined };
  if (s.shown === app) return { state: { shown: app, dismissed, seen }, action: undefined };
  if ((seen?.count ?? 0) < DETECT_AFTER) return { state: { shown: s.shown, dismissed, seen }, action: undefined };
  return { state: { shown: app, dismissed, seen }, action: { kind: "show", app } };
}

/** „Not now“: bis die App das Mikrofon freigibt nicht mehr fragen. */
export function detectDismiss(s: DetectState): { state: DetectState; action: DetectAction } {
  if (s.shown === undefined) return { state: s, action: undefined };
  return { state: { ...s, shown: undefined, dismissed: new Set([...s.dismissed, s.shown]) }, action: { kind: "hide" } };
}

/** Text im Fenster. */
export function promptText(app: string): { title: string; detail: string } {
  return app === ANY_APP
    ? { title: "Meeting detected", detail: "Your microphone is in use. Transcribe it into Based?" }
    : { title: "Meeting detected", detail: `${app} is using your microphone. Transcribe it into Based?` };
}

export const PROMPT_LABEL = "meeting-prompt";
export const PROMPT_ANSWER = "meeting-prompt://answer";
export type PromptAnswer = "start" | "dismiss";
const PROMPT_W = 392;
const PROMPT_H = 152;
const POLL_MS = 3000;

/** Läuft diese Seite als Meeting-Fenster? Dann rendert main.tsx nur meetingPrompt.tsx. */
export function isPromptWindow(search: string = globalThis.location?.search ?? ""): boolean {
  return new URLSearchParams(search).get("window") === PROMPT_LABEL;
}

export interface DetectionOptions {
  enabled: () => boolean;
  recording: () => boolean;
  /** „Start transcribing“: neues Meeting anlegen, Fenster nach vorn, Aufnahme starten. */
  onStart: () => void;
}

/** Nur im Hauptfenster der Mac-App. Gibt eine Funktion zum Beenden zurück. */
export function startMeetingDetection(o: DetectionOptions): () => void {
  if (!isTauri()) return () => undefined;
  let state = DETECT_IDLE;
  let stopped = false;
  let busy = false;
  const apply = (r: { state: DetectState; action: DetectAction }) => {
    state = r.state;
    if (r.action?.kind === "show") void showPrompt(r.action.app);
    if (r.action?.kind === "hide") void hidePrompt();
  };
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      // Ausgeschaltet oder Based nimmt selbst auf: gar nicht erst nachfragen.
      const ask = o.enabled() && !o.recording();
      const ids = ask ? await micUsers() : [];
      if (!stopped) apply(detectStep(state, { app: meetingApp(ids), recording: o.recording(), enabled: o.enabled() }));
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  let unlisten: (() => void) | undefined;
  void import("@tauri-apps/api/event").then(({ listen }) => listen<PromptAnswer>(PROMPT_ANSWER, (e) => {
    if (e.payload === "start") {
      state = { ...state, shown: undefined };
      void hidePrompt();
      o.onStart();
    } else apply(detectDismiss(state));
  })).then((u) => {
    if (stopped) u();
    else unlisten = u;
  }, () => undefined);
  return () => {
    stopped = true;
    clearInterval(timer);
    unlisten?.();
    void hidePrompt();
  };
}

async function micUsers(): Promise<string[]> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("mic_users");
  } catch {
    return [];
  }
}

async function showPrompt(app: string): Promise<void> {
  try {
    const [{ WebviewWindow }, { currentMonitor, primaryMonitor }] = await Promise.all([import("@tauri-apps/api/webviewWindow"), import("@tauri-apps/api/window")]);
    const old = await WebviewWindow.getByLabel(PROMPT_LABEL);
    if (old) await old.close().catch(() => undefined);
    const monitor = (await currentMonitor().catch(() => null)) ?? (await primaryMonitor().catch(() => null));
    const scale = monitor?.scaleFactor ?? 1;
    const right = monitor ? (monitor.position.x + monitor.size.width) / scale : 1440;
    const top = monitor ? monitor.position.y / scale : 0;
    const url = new URL(globalThis.location.href);
    url.search = "";
    url.searchParams.set("window", PROMPT_LABEL);
    url.searchParams.set("app", app);
    url.hash = "";
    // x/y sind logische Punkte. Oben rechts unter der Menüleiste, über allem, ohne Zeile im Dock, ohne Zoom den Fokus zu nehmen.
    new WebviewWindow(PROMPT_LABEL, {
      url: url.toString(), title: "Meeting detected", width: PROMPT_W, height: PROMPT_H,
      x: right - PROMPT_W - 8, y: top + 32,
      decorations: false, transparent: true, shadow: false, resizable: false, alwaysOnTop: true, skipTaskbar: true,
      focus: false, acceptFirstMouse: true, visibleOnAllWorkspaces: true, dragDropEnabled: false,
    });
  } catch {
    // ohne Fenster: dann eben nicht fragen
  }
}

async function hidePrompt(): Promise<void> {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const w = await WebviewWindow.getByLabel(PROMPT_LABEL);
    if (w) await w.close();
  } catch {
    // schon zu
  }
}
