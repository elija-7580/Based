// AI-Schalter (entschieden von Elija am 12.11.2026): Alle AI-Funktionen – Chat, Hauptagent, Aufträge, Runs, Projekte,
// Coding, „Ask AI“ im Editor, Modelle und Schlüssel, MCP-Connections zu fremden Servern – hängen an einem Schalter in
// Einstellungen → Agents & AI. Standard: aus. MCP (Based als Server, lokal und über based-server), Agent Brain
// (Skills, Memories), semantische Suche und Meeting-Transkripte gehören nicht dazu und laufen immer.
//
// Zwei Build-Schalter (vite.config.ts):
//   BASED_CHANNEL=beta  → der Schalter fehlt ganz, AI bleibt aus (Beta-Tester können AI nicht einschalten).
//   BASED_AI_DEFAULT=on → Standard „an“ statt „aus“ (nur für E2E und Entwicklung).
// Die Wahl gilt pro Gerät (localStorage), wie die anderen „My settings“.

declare const __BASED_AI_OPTION__: boolean | undefined;
declare const __BASED_AI_DEFAULT__: boolean | undefined;

/** Darf dieser Build AI überhaupt anbieten? In Beta-Builds nein. */
export const AI_OPTION: boolean = typeof __BASED_AI_OPTION__ === "boolean" ? __BASED_AI_OPTION__ : true;
const AI_DEFAULT: boolean = typeof __BASED_AI_DEFAULT__ === "boolean" ? __BASED_AI_DEFAULT__ : false;

const KEY = "based.ai";

/** Reine Regel (getestet): AI ist an, wenn der Build sie anbietet und die gespeicherte Wahl (sonst der Standard) an ist. */
export function aiOn(option: boolean, stored: unknown, fallback: boolean): boolean {
  if (!option) return false;
  return typeof stored === "boolean" ? stored : fallback;
}

function readStored(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

const listeners = new Set<() => void>();
let cache: boolean | undefined;

export const aiSetting = {
  /** Gilt AI gerade? (für useSyncExternalStore) */
  get: (): boolean => (cache ??= aiOn(AI_OPTION, readStored(), AI_DEFAULT)),
  /** Ohne Wirkung, wenn der Build keine AI anbietet. */
  set: (on: boolean) => {
    if (!AI_OPTION) return;
    cache = on;
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify(on));
    } catch {
      // nur für diese Sitzung
    }
    listeners.forEach((fn) => fn());
  },
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

/** Kurzform für Stellen außerhalb von React. */
export const aiEnabled = (): boolean => aiSetting.get();
