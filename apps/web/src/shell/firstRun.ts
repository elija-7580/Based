// BSD-275 (Mac-Beta): der erste Start ohne Konto. Legt der Store-Worker beim Start einen frischen Workspace an
// (InitResult.created), merkt sich die Shell „Willkommen steht aus“ mit der ID der Willkommensseite; Home zeigt dann den
// Willkommensbildschirm (screens/Welcome.tsx), bis jemand wählt: aus Notion importieren oder leer starten. Der Eintrag
// liegt im localStorage, damit Neuladen vor der Wahl den Bildschirm nicht verliert.
//
// Automatisierte Browser (Playwright: `navigator.webdriver`) bekommen ihn nicht: die bestehenden E2E-Tests starten mit
// leerem Speicher und erwarten die heutige Startseite. Ein Test schaltet ihn mit `globalThis.__basedWelcome = true`
// (addInitScript) ausdrücklich ein.

const KEY = "based.welcome";

export interface WelcomePending {
  /** die Willkommensseite, unter die „leer starten“ die kurzen Anleitungsseiten legt */
  page: string;
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
    return v && typeof v === "object" && typeof (v as WelcomePending).page === "string" ? { page: (v as WelcomePending).page } : undefined;
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
    this.set({ page: r.homePageID });
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
