// BSD-178: Darstellungs-Einstellungen (Settings → Appearance) als Attribute am Wurzelelement, dauerhaft im
// Browser gespeichert. Die Werte selbst kommen aus tokens.css (data-theme, data-style, data-density, data-marker,
// data-calm, data-material).

/** „system“ folgt dem Betriebssystem (wie Appearance.system in der Swift-App). */
export type Theme = "light" | "dark" | "system";
export type EffectiveTheme = "light" | "dark";
export type Style = "default" | "bold";
export type Density = "comfortable" | "compact";
export type Marker = "butter" | "mint" | "sky" | "rose";

export interface Appearance {
  theme: Theme;
  style: Style;
  marker: Marker;
  density: Density;
  calm: boolean;
  /** „Show agent details“: Modell, Laufzeit und Rechte auf Home. */
  agentDetails: boolean;
}

export const DEFAULT_APPEARANCE: Appearance = { theme: "light", style: "default", marker: "butter", density: "comfortable", calm: false, agentDetails: false };

const KEY = "based.appearance";

export function loadAppearance(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Appearance {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { ...DEFAULT_APPEARANCE };
    const v = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: v.theme === "dark" || v.theme === "system" ? v.theme : "light",
      style: v.style === "bold" ? "bold" : "default",
      marker: v.marker === "mint" || v.marker === "sky" || v.marker === "rose" ? v.marker : "butter",
      density: v.density === "compact" ? "compact" : "comfortable",
      calm: v.calm === true,
      agentDetails: v.agentDetails === true,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(a: Appearance, storage: Pick<Storage, "setItem"> | undefined = safeStorage()) {
  try {
    storage?.setItem(KEY, JSON.stringify(a));
  } catch {
    // privater Modus o. Ä.: Einstellung gilt nur für diese Sitzung
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Glas nur auf Apple-Plattformen (ADR 0012, v9); sonst solide Flächen. */
export function platformMaterial(nav: { platform?: string; userAgent?: string } | undefined = globalThis.navigator): "glass" | "solid" {
  const text = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/.test(text) ? "glass" : "solid";
}

/** Bevorzugt das System gerade Dunkel? (ohne matchMedia: nein) */
export function systemPrefersDark(g: { matchMedia?: (q: string) => { matches: boolean } } = globalThis): boolean {
  try {
    return g.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
  } catch {
    return false;
  }
}

/** Das Theme, das wirklich gilt: „system“ wird hier aufgelöst, damit tokens.css und Astryx dasselbe sehen. */
export function effectiveTheme(a: Pick<Appearance, "theme">, prefersDark: boolean = systemPrefersDark()): EffectiveTheme {
  if (a.theme === "system") return prefersDark ? "dark" : "light";
  return a.theme;
}

/** Ruft `fn`, wenn das System zwischen Hell und Dunkel wechselt. */
export function onSystemThemeChange(fn: () => void, g: { matchMedia?: (q: string) => MediaQueryList } = globalThis): () => void {
  const mq = g.matchMedia?.("(prefers-color-scheme: dark)");
  if (!mq?.addEventListener) return () => undefined;
  mq.addEventListener("change", fn);
  return () => mq.removeEventListener("change", fn);
}

type Listener = () => void;
let current: Appearance | undefined;
const listeners = new Set<Listener>();

/** Die Einstellung als kleiner Store: App und `<Theme>` (main.tsx) lesen denselben Wert. */
export const appearanceStore = {
  get: (): Appearance => (current ??= loadAppearance()),
  set(a: Appearance) {
    current = a;
    saveAppearance(a);
    for (const fn of listeners) fn();
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Für Tests. */
  _reset() {
    current = undefined;
    listeners.clear();
  },
};

/** Setzt die Wurzel-Attribute; Standardwerte werden entfernt statt geschrieben. */
export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement, material = platformMaterial(), prefersDark: boolean = systemPrefersDark()) {
  const theme = effectiveTheme(a, prefersDark);
  root.dataset.theme = theme;
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete root.dataset[name];
    else root.dataset[name] = value;
  };
  set("style", a.style === "bold" ? "bold" : undefined);
  set("density", a.density === "compact" ? "compact" : undefined);
  set("marker", a.marker === "butter" ? undefined : a.marker);
  set("calm", a.calm ? "" : undefined);
  set("material", material === "glass" ? "glass" : undefined);
  root.style.colorScheme = theme;
}
