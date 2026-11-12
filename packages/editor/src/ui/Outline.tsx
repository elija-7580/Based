// Schwebende Seitengliederung am rechten Rand: ein Balken je Überschrift, bei Hover (oder Tastaturfokus) klappt die
// Liste mit den Titeln auf; Klick scrollt zur Überschrift, die aktuelle Position ist markiert. Pro Seite abschaltbar
// (`props.format.hideOutline`, wie Swift).
import { activeHeadingIndex, headingOutline, type OutlineHeading, type WorkspaceStore } from "@based/core";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStoreRevision } from "./env.js";

/** Abstand vom oberen Rand, ab dem eine Überschrift als „erreicht“ gilt (Anteil der Höhe des Sichtbereichs). */
const ACTIVE_FRACTION = 0.25;

/** Gliederung für diese Seite ein- oder ausblenden. Ein Undo-Schritt im Store. */
export function setOutlineHidden(store: WorkspaceStore, pageID: string, hidden: boolean): void {
  if (!store.blocks.has(pageID)) return;
  store.transact(hidden ? "Hide outline" : "Show outline", (tx) => tx.update(pageID, (b) => {
    const props = { ...(b.props ?? {}) };
    const format = { ...(props.format ?? {}) };
    if (hidden) format.hideOutline = true;
    else delete format.hideOutline;
    if (Object.keys(format).length > 0) props.format = format;
    else delete props.format;
    if (Object.keys(props).length > 0) b.props = props;
    else delete b.props;
  }));
}

export function isOutlineHidden(store: WorkspaceStore, pageID: string): boolean {
  return store.blocks.get(pageID)?.props?.format?.hideOutline === true;
}

function scrollParent(el: HTMLElement | null): HTMLElement | Window {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    // Nicht prüfen, ob gerade etwas überläuft: beim ersten Aufruf ist die Seite oft noch leer, und wer dann aufs
    // Fenster ausweicht, hört nie wieder ein Scroll-Ereignis (die Markierung blieb auf der ersten Überschrift stehen).
    const o = getComputedStyle(p).overflowY;
    if (o === "auto" || o === "scroll") return p;
  }
  return window;
}

function headingElement(root: HTMLElement | null, id: string): HTMLElement | null {
  return (root ?? document).querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(id)}"]`);
}

/** Zur Überschrift scrollen (auch vom Inhaltsverzeichnis-Block benutzt). */
export function scrollToHeading(root: HTMLElement | null, id: string): void {
  const el = headingElement(root, id);
  if (!el) return;
  const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

export function PageOutline(props: { store: WorkspaceStore; pageID: string; container: HTMLElement | null }) {
  const { store, pageID, container } = props;
  const revision = useStoreRevision(store);
  const headings = useMemo((): OutlineHeading[] => headingOutline(store, pageID), [store, pageID, revision]);
  const hidden = isOutlineHidden(store, pageID);
  const [active, setActive] = useState(0);
  const ids = headings.map((h) => h.id).join("\u0001");
  const idsRef = useRef<string[]>([]);
  idsRef.current = headings.map((h) => h.id);

  useEffect(() => {
    if (hidden || !container || idsRef.current.length === 0) return;
    const scroller = scrollParent(container);
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = scroller instanceof Window ? 0 : scroller.getBoundingClientRect().top;
      const height = scroller instanceof Window ? window.innerHeight : scroller.clientHeight;
      const tops = idsRef.current.map((id) => {
        const el = headingElement(container, id);
        return el ? el.getBoundingClientRect().top - top : Number.POSITIVE_INFINITY;
      });
      const scrolled = scroller instanceof Window ? window.scrollY : scroller.scrollTop;
      const total = scroller instanceof Window ? document.documentElement.scrollHeight : scroller.scrollHeight;
      const atEnd = scrolled > 0 && scrolled + height >= total - 2;
      setActive(Math.max(0, activeHeadingIndex(tops, height * ACTIVE_FRACTION, atEnd)));
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    // Inhalt wächst oder schrumpft (Laden, Tippen, Toggle auf/zu): neu messen.
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(onScroll) : undefined;
    ro?.observe(container);
    return () => {
      ro?.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [container, hidden, ids]);

  // BSD-324: Ist rechts neben dem Text kein Platz (kleines Fenster, Seitenleiste offen), läge der Balken über dem
  // Text – dann ausblenden (wie Notion), bis wieder Platz ist.
  const nav = useRef<HTMLElement>(null);
  const [cramped, setCramped] = useState(false);
  useEffect(() => {
    if (hidden || !container) return;
    const check = () => {
      const n = nav.current;
      if (!n) return;
      const text = container.querySelector(".bn-editor > .bn-block-group") ?? container;
      const textRight = text.getBoundingClientRect().right;
      setCramped(n.getBoundingClientRect().left < textRight);
    };
    check();
    window.addEventListener("resize", check);
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(check) : undefined;
    ro?.observe(container);
    return () => {
      window.removeEventListener("resize", check);
      ro?.disconnect();
    };
  }, [container, hidden, ids]);

  if (hidden || headings.length === 0) return null;
  return (
    <nav ref={nav} className="bx-outline" aria-label="Page outline" data-testid="page-outline" data-cramped={cramped ? "" : undefined} aria-hidden={cramped || undefined}>
      <ul className="bx-outline-list">
        {headings.map((h, i) => (
          <li key={h.id} data-depth={Math.min(h.depth, 3)}>
            <button type="button" className="bx-outline-item" aria-current={i === active ? "location" : undefined} title={h.title}
              onClick={() => {
                setActive(i);
                scrollToHeading(container, h.id);
              }}>
              <span className="bx-outline-bar" aria-hidden />
              <span className="bx-outline-label">{h.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
