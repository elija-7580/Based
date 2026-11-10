// Seitenleiste: Breite ziehbar (gemerkt) und mit ⌘\ einklappbar – wie Notion. Die Breite landet als
// --sidebar-current auf <html>, damit auch die Zugfläche der Titelleiste (desktop.ts, liegt außerhalb der Shell)
// mitwandert. --sidebar-width aus den Tokens bleibt der Standard und das Maß für andere Flächen.

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
export const SIDEBAR_DEFAULT = 232;
const WIDTH_KEY = "based.sidebarWidth";
const HIDDEN_KEY = "based.sidebarHidden";

export function clampSidebar(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR_DEFAULT;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
}

function get(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function put(key: string, v: string) {
  try {
    globalThis.localStorage?.setItem(key, v);
  } catch {
    // nur für diese Sitzung
  }
}

export const sidebarSize = {
  width(): number {
    const raw = get(WIDTH_KEY);
    return raw === null ? SIDEBAR_DEFAULT : clampSidebar(Number(raw));
  },
  setWidth(w: number): number {
    const v = clampSidebar(w);
    put(WIDTH_KEY, String(v));
    return v;
  },
  hidden(): boolean {
    return get(HIDDEN_KEY) === "1";
  },
  setHidden(v: boolean) {
    put(HIDDEN_KEY, v ? "1" : "0");
  },
};

/** Schreibt Breite und Zustand auf <html> (CSS: .sidebar, .titlebar-drag-sidebar). */
export function applySidebar(width: number, hidden: boolean, root: HTMLElement | undefined = globalThis.document?.documentElement) {
  if (!root) return;
  root.style.setProperty("--sidebar-current", `${width}px`);
  if (hidden) root.dataset.sidebar = "hidden";
  else delete root.dataset.sidebar;
}

/** ⌘\ bzw. Strg+\ (ohne weitere Modifikatoren). */
export function isSidebarToggle(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === "\\";
}
