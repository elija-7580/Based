// BSD-244: Zurück/Vor wie im Browser – Maustasten 4/5, ⌘←/⌘→ (Alt+←/→ unter Windows/Linux) außerhalb von Textfeldern und
// waagrechtes Wischen mit zwei Fingern. Die Entscheidung „ist das ein Wisch?“ ist eine reine Zustandsmaschine (getestet).

export interface SwipeState {
  /** Aufgelaufener waagrechter Weg der laufenden Geste (px, rechts positiv). */
  dx: number;
  /** Zeit des letzten Rad-Ereignisses (ms). */
  last: number;
  /** In dieser Geste wurde schon navigiert (oder sie gehört einem scrollbaren Element). */
  spent: boolean;
}

export const SWIPE_DISTANCE = 240;
/** Pause, nach der eine neue Geste beginnt. */
export const SWIPE_IDLE = 220;

export const newSwipe = (): SwipeState => ({ dx: 0, last: -Infinity, spent: false });

export interface WheelLike { deltaX: number; deltaY: number; time: number; ctrlKey?: boolean; blocked?: boolean }

/**
 * Ein Rad-Ereignis einarbeiten. `blocked`: unter dem Zeiger lässt sich in diese Richtung noch scrollen (Tabelle, Board) –
 * dann gehört die ganze Geste dem Element. Ergebnis `go`: -1 zurück (Wisch nach rechts), 1 vor.
 */
export function swipeStep(s: SwipeState, e: WheelLike): { state: SwipeState; go?: -1 | 1; progress: number } {
  let state = e.time - s.last > SWIPE_IDLE ? newSwipe() : { ...s };
  state.last = e.time;
  if (e.ctrlKey) return { state: { ...state, spent: true }, progress: 0 }; // Zoomen
  const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY) * 2;
  if (state.spent) return { state, progress: 0 };
  if (e.blocked || (!horizontal && Math.abs(e.deltaY) > 4)) {
    // Senkrechtes Scrollen oder ein scrollbares Element: diese Geste navigiert nicht mehr.
    state = { ...state, dx: 0, spent: true };
    return { state, progress: 0 };
  }
  if (!horizontal) return { state, progress: state.dx / SWIPE_DISTANCE };
  // Richtungswechsel setzt neu an.
  if (state.dx !== 0 && Math.sign(state.dx) !== Math.sign(-e.deltaX)) state.dx = 0;
  state.dx -= e.deltaX; // Finger nach rechts = deltaX negativ = zurück
  if (Math.abs(state.dx) >= SWIPE_DISTANCE) {
    const go = state.dx > 0 ? -1 : 1;
    return { state: { ...state, dx: 0, spent: true }, go, progress: 0 };
  }
  return { state, progress: state.dx / SWIPE_DISTANCE };
}

/** Kann ein Element zwischen `target` und `stop` in Richtung `deltaX` noch waagrecht scrollen? */
export function canScrollX(target: Element | null, stop: Element | null, deltaX: number): boolean {
  for (let el = target; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const ox = getComputedStyle(el).overflowX;
    if (ox !== "auto" && ox !== "scroll") continue;
    if (deltaX < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  }
  return false;
}

const inText = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
};

export interface HistoryLike { back(): void; forward(): void; readonly canBack: boolean; readonly canForward: boolean }

/** Hängt alles an `win`; Rückgabe räumt auf. `onProgress` (−1…1) treibt den Hinweis am Rand. */
export function installHistoryGestures(win: Window, history: HistoryLike, onProgress: (p: number) => void = () => undefined, apple = /Mac|iPhone|iPad/.test(win.navigator?.platform ?? "")): () => void {
  const go = (d: -1 | 1) => (d < 0 ? history.back() : history.forward());
  // Maustasten 4/5: der Browser würde sonst selbst navigieren (aus der App heraus).
  const mouse = (e: MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.type === "mouseup") go(e.button === 3 ? -1 : 1);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.shiftKey || e.defaultPrevented || inText(e.target)) return;
    // ⌘←/⌘→ auf Apple (⌥←/→ springt dort wortweise), Alt+←/→ sonst – wie im Browser.
    const cmd = apple && e.metaKey && !e.ctrlKey && !e.altKey, alt = !apple && e.altKey && !e.metaKey && !e.ctrlKey;
    if (!cmd && !alt) return;
    e.preventDefault();
    go(e.key === "ArrowLeft" ? -1 : 1);
  };
  let state = newSwipe();
  let clear: ReturnType<typeof setTimeout> | undefined;
  const wheel = (e: WheelEvent) => {
    if (e.deltaMode !== 0) return; // Mausrad mit Zeilen: kein Wischen
    const blocked = Math.abs(e.deltaX) > Math.abs(e.deltaY) && canScrollX(e.target as Element | null, null, e.deltaX);
    const r = swipeStep(state, { deltaX: e.deltaX, deltaY: e.deltaY, time: e.timeStamp, ctrlKey: e.ctrlKey, blocked });
    state = r.state;
    const possible = r.progress > 0 ? history.canBack : r.progress < 0 ? history.canForward : false;
    onProgress(possible ? Math.max(-1, Math.min(1, r.progress)) : 0);
    clearTimeout(clear);
    clear = setTimeout(() => onProgress(0), SWIPE_IDLE);
    if (r.go) go(r.go);
  };
  win.addEventListener("mousedown", mouse);
  win.addEventListener("mouseup", mouse);
  win.addEventListener("keydown", key);
  win.addEventListener("wheel", wheel, { passive: true });
  return () => {
    win.removeEventListener("mousedown", mouse);
    win.removeEventListener("mouseup", mouse);
    win.removeEventListener("keydown", key);
    win.removeEventListener("wheel", wheel);
    clearTimeout(clear);
  };
}
