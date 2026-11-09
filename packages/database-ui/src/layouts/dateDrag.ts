// BSD-8: Ziehen auf Kalender und Timeline mit Zeiger-Ereignissen (Maus, Stift, Touch): Einträge verschieben,
// Balkenenden ziehen, Zeilen ohne Datum auf die Zeitachse legen. Während des Ziehens zeigt die Ansicht eine
// Vorschau (`drag`); geschrieben wird erst beim Loslassen – genau eine Store-Transaktion. Ohne Bewegung ist es
// ein gewöhnlicher Klick (das Element öffnet selbst die Seite); nach echtem Ziehen wird der folgende Klick
// verschluckt. Escape bricht ab.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type DragKind = "move" | "start" | "end" | "place";

export interface DateDrag {
  rowID: string;
  kind: DragKind;
  /** Tag unter dem Zeiger beim Start bzw. jetzt (undefined: außerhalb). */
  origin: number;
  day: number | undefined;
  /** day − origin (für „move“). */
  delta: number;
}

export interface DateDragOptions {
  /** Tag unter einem Bildschirmpunkt (oder undefined). */
  dayAt: (x: number, y: number) => number | undefined;
  /** Loslassen nach echtem Ziehen. */
  onDrop: (d: DateDrag) => void;
  /** Scroll-Container für Auto-Scroll am Rand. */
  scrollEl?: () => HTMLElement | null;
}

const THRESHOLD = 4;
const EDGE = 32;

export function useDateDrag(opts: DateDragOptions) {
  const [drag, setDrag] = useState<DateDrag | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const begin = useCallback((e: ReactPointerEvent<HTMLElement>, rowID: string, kind: DragKind, originDay?: number) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
    e.stopPropagation();
    cleanup.current?.();
    const x0 = e.clientX, y0 = e.clientY;
    const origin = originDay ?? optsRef.current.dayAt(x0, y0);
    if (origin === undefined) return;
    let active = false, shown = false;
    let current: DateDrag = { rowID, kind, origin, day: origin, delta: 0 };
    const move = (ev: PointerEvent) => {
      if (!active) {
        if (Math.abs(ev.clientX - x0) < THRESHOLD && Math.abs(ev.clientY - y0) < THRESHOLD) return;
        active = true;
        document.body.classList.add("dbui-dragging");
      }
      ev.preventDefault();
      px = ev.clientX; py = ev.clientY;
      update();
    };
    // Auto-Scroll am Rand: erst nach kurzem Verweilen im Randstreifen (nicht beim bloßen Durchqueren).
    let px = x0, py = y0, edgeSince = 0, frame = 0;
    const tick = (t: number) => {
      frame = requestAnimationFrame(tick);
      const sc = optsRef.current.scrollEl?.();
      if (!active || !sc) return;
      const r = sc.getBoundingClientRect();
      const inside = px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
      const dy = py < r.top + EDGE ? -1 : py > r.bottom - EDGE ? 1 : 0;
      const dx = px < r.left + EDGE ? -1 : px > r.right - EDGE ? 1 : 0;
      if (!inside || (dx === 0 && dy === 0)) { edgeSince = 0; return; }
      if (!edgeSince) { edgeSince = t; return; }
      if (t - edgeSince < 250) return;
      sc.scrollTop += dy * EDGE / 2;
      sc.scrollLeft += dx * EDGE / 2;
      update();
    };
    frame = requestAnimationFrame(tick);
    const update = () => {
      const day = optsRef.current.dayAt(px, py);
      const next: DateDrag = { rowID, kind, origin, day: kind === "place" ? day : day ?? current.day, delta: (day ?? current.day ?? origin) - origin };
      if (!shown || next.day !== current.day) {
        shown = true;
        current = next;
        setDrag(next);
      }
    };
    const end = (ev: PointerEvent | null) => {
      stop();
      if (!active) return;
      const swallow = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), ev ? 0 : 1000);
      if (!ev) return;
      const at = optsRef.current.dayAt(ev.clientX, ev.clientY);
      // Ablegen außerhalb der Fläche: verschieben behält den letzten Tag, „place“ (ohne Datum) bricht ab.
      const day = kind === "place" ? at : at ?? current.day;
      optsRef.current.onDrop({ ...current, day, delta: (day ?? origin) - origin });
    };
    const up = (ev: PointerEvent) => end(ev);
    const cancel = () => end(null);
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.preventDefault(); cancel(); } };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      cancelAnimationFrame(frame);
      document.body.classList.remove("dbui-dragging");
      cleanup.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    cleanup.current = stop;
  }, []);

  return { drag, begin };
}

/** Tag aus dem obersten Element mit `data-day` unter einem Punkt (Kalenderzellen). */
export function dayFromPoint(x: number, y: number, root: HTMLElement | null): number | undefined {
  if (!root) return undefined;
  for (const el of document.elementsFromPoint(x, y)) {
    if (!root.contains(el)) continue;
    const cell = (el as HTMLElement).closest<HTMLElement>("[data-day]");
    if (cell && root.contains(cell)) return Number(cell.dataset.day);
  }
  return undefined;
}
