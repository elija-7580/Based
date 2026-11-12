// Schwebende Based-Ebenen (Kontextmenü, Auswahlliste, Kalender): liegen über allem, nehmen dem Feld darunter den
// Fokus nicht weg und schließen bei Klick daneben, Escape, Scrollen oder Fensterwechsel. Ereignisse in einer Ebene
// werden am Fenster abgefangen, damit ein Popover oder Dialog darunter sie nicht als „Klick außerhalb“ wertet.
import { place, pointBox, type Box } from "./logic.js";

export type LayerAnchor = Element | { x: number; y: number };

export interface LayerOptions {
  anchor: LayerAnchor;
  /** Tasten, solange die Ebene oben liegt; `true` = verbraucht. Escape schließt immer. */
  onKey?: (e: KeyboardEvent) => boolean;
  /** Klick auf ein Element mit `data-nf-act` in der Ebene. */
  onAct?: (act: string, el: HTMLElement) => void;
  onClose?: () => void;
  minWidthOfAnchor?: boolean;
  /** Bei einem Punkt als Anker: das Element darunter – scrollt ein Bereich, der es enthält, schließt die Ebene. */
  scrollWith?: Element;
}

export interface Layer { el: HTMLElement; close(): void; readonly open: boolean; reposition(): void }

interface Entry extends Layer { opts: LayerOptions }

const layers: Entry[] = [];
/** Letzte bekannte Zeigerposition (für Menüs: ein ruhender Zeiger unter einer neuen Ebene wählt nichts aus). */
export const pointer = { x: -1, y: -1 };
let installed = false;

const inLayer = (t: EventTarget | null): Entry | undefined => {
  if (!(t instanceof Node)) return undefined;
  return layers.find((l) => l.el.contains(t));
};

export const hasLayers = () => layers.length > 0;

export function closeLayers() {
  for (const l of [...layers].reverse()) l.close();
}

/** Früh aufrufen (installNativeFree), damit die Zeigerposition schon vor der ersten Ebene bekannt ist. */
export function installLayers() { install(); }

function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("mousemove", (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { capture: true, passive: true });
  const swallow = (e: Event) => {
    const hit = inLayer(e.target);
    if (!hit) return false;
    e.stopPropagation();
    return true;
  };
  for (const type of ["pointerdown", "mousedown"] as const) {
    window.addEventListener(type, (e) => {
      if (swallow(e)) { e.preventDefault(); return; }
      // Klick daneben: alles schließen. Der Anker selbst entscheidet (Auswahlfeld: zweiter Klick schließt).
      for (const l of [...layers].reverse()) {
        const a = l.opts.anchor;
        if (a instanceof Element && e.target instanceof Node && a.contains(e.target)) continue;
        l.close();
      }
    }, true);
  }
  for (const type of ["pointerup", "mouseup", "dblclick", "auxclick"] as const) window.addEventListener(type, swallow, true);
  window.addEventListener("click", (e) => {
    const hit = inLayer(e.target);
    if (!hit) return;
    e.stopPropagation();
    e.preventDefault();
    const el = (e.target as Element).closest<HTMLElement>("[data-nf-act]");
    if (el && hit.el.contains(el) && el.getAttribute("aria-disabled") !== "true") hit.opts.onAct?.(el.dataset.nfAct!, el);
  }, true);
  window.addEventListener("contextmenu", (e) => { if (swallow(e)) e.preventDefault(); }, true);
  window.addEventListener("keydown", (e) => {
    const top = layers[layers.length - 1];
    if (!top) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); top.close(); return; }
    if (e.key === "Tab") { closeLayers(); return; }
    if (top.opts.onKey?.(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // Nur wenn der Anker selbst wegscrollt (nicht bei jedem Scrollen irgendwo, z. B. einer Trefferliste, die nachlädt).
  window.addEventListener("scroll", (e) => {
    const t = e.target;
    for (const l of [...layers].reverse()) {
      const a = l.opts.anchor instanceof Element ? l.opts.anchor : l.opts.scrollWith;
      if (t instanceof Document || !a || (t instanceof Node && t !== l.el && !l.el.contains(t) && t.contains(a))) l.close();
    }
  }, true);
  window.addEventListener("resize", closeLayers);
  window.addEventListener("blur", closeLayers);
}

/** Offener modaler Dialog bzw. Popover, in dem die Ebene liegen muss, um bedienbar zu sein; sonst <body>. */
function hostFor(anchor: LayerAnchor): HTMLElement {
  if (anchor instanceof Element) {
    const near = anchor.closest<HTMLElement>("dialog[open], [popover]");
    if (near) return near;
  }
  try {
    const modal = document.querySelectorAll<HTMLElement>("dialog:modal");
    if (modal.length) return modal[modal.length - 1]!;
  } catch { /* :modal unbekannt */ }
  return document.body;
}

const boxOf = (a: LayerAnchor): Box => {
  if (!(a instanceof Element)) return pointBox(a.x, a.y);
  const r = a.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
};

export function openLayer(el: HTMLElement, opts: LayerOptions): Layer {
  install();
  el.classList.add("nf-layer");
  el.style.visibility = "hidden";
  hostFor(opts.anchor).appendChild(el);
  // Top Layer (über modalen Dialogen, ohne Beschnitt durch overflow/transform). Ohne Popover-API: fixed + z-index.
  try { el.setAttribute("popover", "manual"); el.showPopover(); } catch { el.removeAttribute("popover"); }
  let open = true;
  const entry: Entry = {
    el, opts,
    get open() { return open; },
    reposition() {
      const anchor = boxOf(opts.anchor);
      if (opts.minWidthOfAnchor) el.style.minWidth = `${Math.round(anchor.width)}px`;
      const at = place(anchor, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight },
        { gap: opts.anchor instanceof Element ? 4 : 0 });
      el.style.left = `${at.left}px`;
      el.style.top = `${at.top}px`;
    },
    close() {
      if (!open) return;
      open = false;
      const i = layers.indexOf(entry);
      if (i >= 0) layers.splice(i, 1);
      el.remove();
      opts.onClose?.();
    },
  };
  layers.push(entry);
  entry.reposition();
  el.style.visibility = "";
  return entry;
}
