// Virtualisierte Liste mit fester Zeilenhöhe: rendert nur die sichtbaren Zeilen (plus Vorrat), egal wie lang die
// Liste ist. Der Inhalt jeder Zeile kommt von `renderRow`; Schlüssel über `rowKey`, damit Zeilen beim Scrollen
// ihren DOM-Knoten behalten. Rendert bei jedem Scroll nur, wenn sich das Fenster ändert.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { sameRange, scrollToReveal, windowRange, type WindowRange } from "./virtual.js";

export interface VirtualListProps {
  count: number;
  rowHeight: number;
  rowKey: (index: number) => string;
  renderRow: (index: number, style: CSSProperties) => ReactNode;
  overscan?: number;
  className?: string;
  /** Zeile, die sichtbar sein soll (z. B. die aktive Seite). */
  revealIndex?: number;
  "aria-label"?: string;
  role?: string;
  /** Für Tests und Messungen: aktuelle Fenstergröße. */
  onRangeChange?: (r: WindowRange) => void;
}

export function VirtualList({ count, rowHeight, rowKey, renderRow, overscan = 8, className, revealIndex, onRangeChange, ...aria }: VirtualListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<WindowRange>(() => windowRange(count, rowHeight, 0, 800, overscan));
  const rangeRef = useRef(range);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = windowRange(count, rowHeight, el.scrollTop, el.clientHeight || 800, overscan);
    if (!sameRange(next, rangeRef.current)) {
      rangeRef.current = next;
      setRange(next);
    }
  }, [count, rowHeight, overscan]);

  useLayoutEffect(update, [update]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, [update]);
  useEffect(() => onRangeChange?.(range), [range, onRangeChange]);
  useEffect(() => {
    const el = ref.current;
    if (!el || revealIndex === undefined || revealIndex < 0) return;
    const top = scrollToReveal(revealIndex, rowHeight, el.scrollTop, el.clientHeight);
    if (top !== el.scrollTop) el.scrollTop = top;
  }, [revealIndex, rowHeight]);

  const rows: ReactNode[] = [];
  for (let i = range.start; i < Math.min(range.end, count); i++) {
    rows.push(<div key={rowKey(i)} style={{ position: "absolute", top: 0, left: 0, right: 0, height: rowHeight, transform: `translateY(${i * rowHeight}px)` }}>{renderRow(i, { height: rowHeight })}</div>);
  }
  return (
    <div ref={ref} className={className} style={{ overflowY: "auto", position: "relative", contain: "strict" }} {...aria}>
      <div style={{ height: count * rowHeight, position: "relative" }}>{rows}</div>
    </div>
  );
}
