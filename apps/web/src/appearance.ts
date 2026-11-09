// BSD-178: Darstellungs-Einstellungen (Settings → Appearance) als Attribute am Wurzelelement, dauerhaft im
// Browser gespeichert. Die Werte selbst kommen aus tokens.css (data-theme, data-style, data-density, data-marker,
// data-calm, data-material).

export type Theme = "light" | "dark";
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
      theme: v.theme === "dark" ? "dark" : "light",
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

/** Setzt die Wurzel-Attribute; Standardwerte werden entfernt statt geschrieben. */
export function applyAppearance(a: Appearance, root: HTMLElement = document.documentElement, material = platformMaterial()) {
  root.dataset.theme = a.theme;
  const set = (name: string, value: string | undefined) => {
    if (value === undefined) delete root.dataset[name];
    else root.dataset[name] = value;
  };
  set("style", a.style === "bold" ? "bold" : undefined);
  set("density", a.density === "compact" ? "compact" : undefined);
  set("marker", a.marker === "butter" ? undefined : a.marker);
  set("calm", a.calm ? "" : undefined);
  set("material", material === "glass" ? "glass" : undefined);
  root.style.colorScheme = a.theme;
}
