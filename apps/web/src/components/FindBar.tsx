// BSD-206: Suchleiste „Find in page“ (⌘F) oben rechts in der Seite. Enter/⌘G weiter, ⇧Enter/⇧⌘G zurück, Esc schließt.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../icons.js";
import { clearMatches, findRanges, firstVisibleIndex, MAX_MATCHES, paintMatches, revealRange } from "../shell/findInPage.js";

interface Props {
  /** Wurzel, in der gesucht wird (die Seite). */
  root: () => Element | null;
  /** Zählt hoch, wenn ⌘F erneut gedrückt wird (Feld fokussieren und markieren). */
  focusSignal: number;
  /** ⌘G / ⇧⌘G von außerhalb des Feldes: { n: Zähler, delta }. */
  step: { n: number; delta: 1 | -1 };
  onClose: () => void;
}

export function FindBar({ root, focusSignal, step, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);
  const scroller = useCallback(() => root()?.closest(".panel") ?? null, [root]);

  // Vor dem nächsten Tastendruck fokussieren (Layout-Effekt): wer ⌘F drückt und sofort tippt, verliert kein Zeichen an den Editor.
  useLayoutEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [focusSignal]);

  // Suchen: bei jeder Eingabe und – entprellt – wenn sich die Seite ändert (Tippen im Editor, Zeilen laden nach).
  useEffect(() => {
    const el = root();
    let first = true;
    const run = () => {
      const found = el && query ? findRanges(el, query) : [];
      ranges.current = found;
      setCount(found.length);
      setCurrent((c) => {
        const next = first ? firstVisibleIndex(found, scroller()) : Math.min(c, Math.max(0, found.length - 1));
        paintMatches(found, next);
        if (first && found[next]) revealRange(found[next], scroller());
        first = false;
        return next;
      });
    };
    run();
    if (!el || !query) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const mo = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 150);
    });
    mo.observe(el, { childList: true, characterData: true, subtree: true });
    return () => {
      mo.disconnect();
      clearTimeout(timer);
    };
  }, [query, root, scroller]);

  useEffect(() => clearMatches, []);

  const go = useCallback((delta: 1 | -1) => {
    const n = ranges.current.length;
    if (n === 0) return;
    setCurrent((c) => {
      const next = (c + delta + n) % n;
      paintMatches(ranges.current, next);
      revealRange(ranges.current[next]!, scroller());
      return next;
    });
  }, [scroller]);

  const lastStep = useRef(step.n);
  useEffect(() => {
    if (step.n !== lastStep.current) {
      lastStep.current = step.n;
      go(step.delta);
    }
  }, [step, go]);

  const label = !query ? "" : count === 0 ? "No results" : `${current + 1} of ${count >= MAX_MATCHES ? `${MAX_MATCHES}+` : count}`;
  return (
    <div className="find-bar" role="search" aria-label="Find in page" data-testid="find-bar">
      <Icon name="search" size={16} />
      <input
        ref={input}
        aria-label="Find in page"
        placeholder="Find in page"
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="find-count t-meta" role="status" aria-live="polite" data-testid="find-count">{label}</span>
      <button type="button" className="icon-btn ghost" aria-label="Previous match" title="Previous (⇧Enter)" disabled={count === 0} onClick={() => go(-1)}><span className="flip"><Icon name="chevron" size={16} /></span></button>
      <button type="button" className="icon-btn ghost" aria-label="Next match" title="Next (Enter)" disabled={count === 0} onClick={() => go(1)}><Icon name="chevron" size={16} /></button>
      <button type="button" className="icon-btn ghost" aria-label="Close find" title="Close (Esc)" onClick={onClose}><Icon name="close" size={16} /></button>
    </div>
  );
}
