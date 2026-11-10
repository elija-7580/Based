// Kleine Hilfen der Startseite: Uhr (pausiert im Hintergrund, Akku schonen), weggelegte Auftragskarten, Bewegung.
import { useEffect, useState, useSyncExternalStore } from "react";

/** Aktuelle Zeit, alle `everyMs` neu; im Hintergrund-Tab angehalten. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), everyMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    };
    const vis = () => (document.hidden ? stop() : (stop(), start()));
    start();
    document.addEventListener("visibilitychange", vis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", vis);
    };
  }, [everyMs]);
  return now;
}

const DISMISSED_KEY = "based.home.dismissed";
const listeners = new Set<() => void>();
let dismissed: ReadonlySet<string> = load();

function load(): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Auftragskarten, die der Nutzer vom Composer weggelegt hat (bleiben auf dem Bogen). */
export const dismissedCards = {
  get: (): ReadonlySet<string> => dismissed,
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  add(id: string) {
    dismissed = new Set([...dismissed, id].slice(-100));
    try {
      globalThis.localStorage?.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
    } catch {
      // nur für diese Sitzung
    }
    for (const fn of listeners) fn();
  },
};

export const useDismissed = () => useSyncExternalStore(dismissedCards.subscribe, dismissedCards.get);

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** „14:02“. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Uhrzeit, mit Wochentag wenn nicht heute („Mon 09:00“). */
export function when(ms: number, nowMs: number): string {
  const d = new Date(ms), n = new Date(nowMs);
  const sameDay = d.toDateString() === n.toDateString();
  return sameDay ? clock(ms) : `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${clock(ms)}`;
}
