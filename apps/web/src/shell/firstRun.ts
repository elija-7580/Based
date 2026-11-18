// BSD-275 (Mac-Beta): der erste Start ohne Konto. Legt der Store-Worker beim Start einen frischen Workspace an
// (InitResult.created), merkt sich die Shell „Willkommen steht aus“ mit der ID der Willkommensseite; Home zeigt dann den
// Willkommensbildschirm (screens/Welcome.tsx), bis jemand wählt: aus Notion importieren oder leer starten. Der Eintrag
// liegt im localStorage, damit Neuladen vor der Wahl den Bildschirm nicht verliert.
//
// Automatisierte Browser (Playwright: `navigator.webdriver`) bekommen ihn nicht: die bestehenden E2E-Tests starten mit
// leerem Speicher und erwarten die heutige Startseite. Ein Test schaltet ihn mit `globalThis.__basedWelcome = true`
// (addInitScript) ausdrücklich ein.
//
// BSD-551: vor der Wahl steht ein Einstieg in Schritten (screens/WelcomeTour.tsx). Der Schritt liegt mit im Merker,
// damit Neuladen und ein Abstecher in die Einstellungen ihn nicht verlieren. Merker ohne Schritt stammen aus 0.2.x –
// dort geht es direkt zur Wahl („start“), der Einstieg kommt also nicht ungefragt. `welcomeTour` öffnet ihn später
// erneut (Hilfe → Show Welcome Tour, ⌘K), nur zum Lesen: dabei wird nichts angelegt.

const KEY = "based.welcome";

/** Die Schritte des Einstiegs; „start“ ist die Wahl (Import, leer, Vorlage). */
export type TourStepID = "welcome" | "data" | "meetings" | "beta" | "start";
const STEP_IDS: readonly TourStepID[] = ["welcome", "data", "meetings", "beta", "start"];

export interface WelcomePending {
  /** die Willkommensseite, unter die „leer starten“ die kurzen Anleitungsseiten legt */
  page: string;
  /** BSD-551: aktueller Schritt des Einstiegs; fehlt er (Merker aus 0.2.x), geht es direkt zur Wahl */
  step?: TourStepID;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let cache: WelcomePending | undefined | null = null;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function load(): WelcomePending | undefined {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || typeof (v as WelcomePending).page !== "string") return undefined;
    const step = (v as WelcomePending).step;
    return { page: (v as WelcomePending).page, ...(step && STEP_IDS.includes(step) ? { step } : {}) };
  } catch {
    return undefined;
  }
}

/** Darf diese Umgebung den Willkommensbildschirm zeigen? Nein in automatisierten Browsern, außer ein Test will ihn. */
export function welcomeAllowed(env: { webdriver?: boolean; force?: unknown } = {
  webdriver: (globalThis.navigator as Navigator | undefined)?.webdriver,
  force: (globalThis as { __basedWelcome?: unknown }).__basedWelcome,
}): boolean {
  if (env.force === true) return true;
  if (env.force === false) return false;
  return env.webdriver !== true;
}

let listening = false;
/** Wählt jemand in einem anderen Tab, verschwindet der Bildschirm auch hier. */
function installStorageListener() {
  if (listening || typeof addEventListener !== "function") return;
  listening = true;
  addEventListener("storage", (e: StorageEvent) => {
    if (e.key !== KEY && e.key !== null) return;
    cache = null;
    listeners.forEach((f) => f());
  });
}

export const firstRun = {
  get(): WelcomePending | undefined {
    if (cache === null) cache = load();
    return cache;
  },
  subscribe(fn: Listener): () => void {
    if (listeners.size === 0) installStorageListener();
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Nach `init`: frisch angelegter Workspace mit Willkommensseite → Willkommen steht aus (wenn erlaubt). */
  noteInit(r: { created?: boolean; homePageID?: string; persistent?: boolean }, allowed = welcomeAllowed()): void {
    // nur im Speicher (kein OPFS): jeder Start wäre ein „erster“ – dann kein Willkommen, sonst käme es immer wieder
    if (!r.created || !r.homePageID || r.persistent === false || !allowed) return;
    this.set({ page: r.homePageID, step: "welcome" });
  },
  /** BSD-551: zum Schritt `step` des Einstiegs (übersteht Neuladen). */
  setStep(step: TourStepID): void {
    const v = this.get();
    if (v && v.step !== step) this.set({ ...v, step });
  },
  set(v: WelcomePending | undefined): void {
    cache = v;
    try {
      if (v) storage()?.setItem(KEY, JSON.stringify(v));
      else storage()?.removeItem(KEY);
    } catch {
      // nur für diese Sitzung
    }
    listeners.forEach((f) => f());
  },
  /** Wahl getroffen (oder übersprungen): nicht wieder zeigen. */
  done(): void {
    this.set(undefined);
  },
  /** nur für Tests: Zwischenspeicher verwerfen */
  _reset(): void {
    cache = null;
  },
};

/**
 * BSD-551: Einstieg erneut zeigen (Hilfe → Show Welcome Tour, ⌘K). Nur für diese Sitzung; legt nichts an und fasst
 * den Merker oben nicht an.
 */
const tourListeners = new Set<Listener>();
let tourOpen = false;
export const welcomeTour = {
  get: (): boolean => tourOpen,
  subscribe(fn: Listener): () => void {
    tourListeners.add(fn);
    return () => tourListeners.delete(fn);
  },
  show(): void { if (!tourOpen) { tourOpen = true; tourListeners.forEach((f) => f()); } },
  close(): void { if (tourOpen) { tourOpen = false; tourListeners.forEach((f) => f()); } },
};
