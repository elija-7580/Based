// BSD-155: kleine Bausteine der Datenbank-Oberfläche: Popover (mit Stapel, Escape, Klick außerhalb),
// Menüeinträge, Icons (2-px-Strich, 24er-Raster, runde Enden), Options-Pillen.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { optionTone } from "./logic/values.js";

// MARK: Popover

interface StackEntry { el: HTMLElement; anchor: Element | null; close: () => void }
const stack: StackEntry[] = [];
let listening = false;

function onPointerDown(e: Event) {
  const top = stack[stack.length - 1];
  const t = e.target as Node | null;
  if (!top || !t) return;
  if (top.el.contains(t) || top.anchor?.contains(t)) return;
  top.close();
}
function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.stopPropagation();
  e.preventDefault();
  top.close();
}
function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("keydown", onKey, true);
}

export type Anchor = HTMLElement | DOMRect | { x: number; y: number };

export interface PopoverProps {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  label?: string;
  className?: string;
  /** Breite wie der Anker (Zellen-Editoren). */
  matchWidth?: boolean;
  /** Über den Anker legen statt darunter (Zellen-Editoren). */
  cover?: boolean;
  role?: string;
}

/**
 * Offenes Top-Layer-Element (modaler Dialog, Drawer), in dem der Anker liegt. Ein Popover am <body> läge darunter
 * und wäre bei einem modalen Dialog nicht bedienbar – es wird deshalb dort hineingehängt und selbst ins Top Layer
 * gehoben (Popover-API), damit weder Transform noch Overflow des Dialogs es verschieben oder abschneiden.
 */
function topLayerHost(anchor: Anchor): HTMLElement | null {
  if (typeof document === "undefined") return null;
  if (anchor instanceof HTMLElement) return anchor.closest<HTMLElement>("dialog[open], [popover]");
  try {
    const modal = document.querySelectorAll<HTMLElement>("dialog:modal");
    return modal[modal.length - 1] ?? null;
  } catch {
    return null;
  }
}

const rectOf = (a: Anchor): DOMRect => (a instanceof HTMLElement ? a.getBoundingClientRect() : "width" in a ? a : new DOMRect(a.x, a.y, 0, 0));

export function Popover({ anchor, onClose, children, label, className, matchWidth, cover, role = "dialog" }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden", top: 0, left: 0 });
  const host = useMemo(() => topLayerHost(anchor), [anchor]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (host) try { el.showPopover(); } catch { /* schon offen oder nicht unterstützt */ }
    const r = rectOf(anchor);
    const w = el.offsetWidth, h = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight, m = 8;
    let top = cover ? r.top : r.bottom + 4;
    if (top + h > vh - m) top = Math.max(m, cover ? vh - m - h : r.top - 4 - h);
    let left = r.left;
    if (left + w > vw - m) left = Math.max(m, vw - m - w);
    setStyle({ top, left, ...(matchWidth ? { minWidth: Math.max(r.width, 200) } : {}) });
  }, [anchor, cover, matchWidth, host]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    listen();
    const entry: StackEntry = { el, anchor: anchor instanceof HTMLElement ? anchor : null, close: () => closeRef.current() };
    stack.push(entry);
    const auto = el.querySelector<HTMLElement>("[data-autofocus]") ?? el.querySelector<HTMLElement>("input, textarea, select");
    auto?.focus();
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [anchor]);

  return createPortal(
    <div ref={ref} className={"dbui-popover" + (className ? " " + className : "")} style={style} role={role} aria-label={label} popover={host ? "manual" : undefined}
      onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    host ?? document.body,
  );
}

/** Zustand für ein Popover an einem Element: `[anchor, open(el), close]`. */
export function usePopover(): [Anchor | null, (a: Anchor) => void, () => void] {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  return [anchor, setAnchor, () => setAnchor(null)];
}

export function MenuItem({ icon, children, onClick, selected, danger, disabled, hint, testID }: {
  icon?: ReactNode; children: ReactNode; onClick?: () => void; selected?: boolean; danger?: boolean; disabled?: boolean; hint?: ReactNode; testID?: string;
}) {
  return (
    <button type="button" role="menuitem" className={"dbui-menu-item" + (danger ? " danger" : "")} aria-checked={selected} disabled={disabled}
      onClick={onClick} data-testid={testID}>
      {icon && <span className="dbui-menu-icon" aria-hidden>{icon}</span>}
      <span className="dbui-menu-label">{children}</span>
      {hint !== undefined && <span className="dbui-menu-hint">{hint}</span>}
      {selected && <span className="dbui-menu-check" aria-hidden><Icon name="check" /></span>}
    </button>
  );
}

export const MenuSeparator = () => <div className="dbui-menu-sep" role="separator" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="dbui-menu-heading">{children}</div>;

// MARK: Icons

const PATHS: Record<string, string> = {
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7.5",
  close: "M6 6l12 12M18 6L6 18",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  chevronLeft: "M15 6l-6 6 6 6",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4",
  filter: "M4 6h16M7 12h10M10 18h4",
  sort: "M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3",
  open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  copy: "M8 8h11v11H8zM5 16V5h11",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6",
  settings: "M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6",
  table: "M4 5h16v14H4zM4 10h16M10 10v9",
  board: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v11h-4z",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  gallery: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  chart: "M5 20V10M12 20V4M19 20v-7",
  dashboard: "M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  timeline: "M4 7h9M8 12h12M6 17h8",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  group: "M4 5h16M4 12h16M4 19h10",
  text: "M5 6h14M12 6v13",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  formula: "M16 5h-6l-2 14M7 11h7",
  warning: "M12 4l9 16H3zM12 10v4M12 17h.01",
  hash: "M9 4L7 20M17 4l-2 16M4 9h16M3 15h16",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  file: "M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7zM14 3v4h4",
  form: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM9 8h6M9 12h6M9 16h3",
  minus: "M5 12h14",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  pin: "M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
};

export function Icon({ name, size = 16, label }: { name: string; size?: number; label?: string }) {
  return (
    <svg className="dbui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round"
      strokeLinejoin="round" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={PATHS[name] ?? PATHS.more} />
    </svg>
  );
}

export const VIEW_ICONS: Record<string, string> = {
  table: "table", board: "board", list: "list", gallery: "gallery", chart: "chart", dashboard: "dashboard", calendar: "calendar", timeline: "timeline",
  form: "form", map: "pin",
};

export const PROPERTY_ICONS: Record<string, string> = {
  title: "text", text: "text", number: "hash", select: "chevronDown", multiSelect: "list", status: "check", date: "calendar", person: "person",
  files: "file", checkbox: "check", url: "link", email: "link", phone: "link", formula: "formula", relation: "open", rollup: "search",
  createdTime: "calendar", lastEditedTime: "calendar", createdBy: "person", lastEditedBy: "person", button: "plus", uniqueID: "hash", place: "pin",
};

export function OptionPill({ name, color, status, onRemove }: { name: string; color: string | null | undefined; status?: boolean; onRemove?: () => void }) {
  return (
    <span className={`dbui-pill tone-${optionTone(color)}${status ? " status" : ""}`}>
      {status && <span className="dbui-dot" aria-hidden />}
      <span className="dbui-pill-text">{name}</span>
      {onRemove && (
        <button type="button" className="dbui-pill-x" aria-label={`Remove ${name}`} onClick={(e) => { e.stopPropagation(); onRemove(); }}>
          <Icon name="close" size={10} />
        </button>
      )}
    </span>
  );
}

/** Bestätigungsdialog (z. B. Datenverlust beim Typwechsel). */
export function Confirm({ anchor, message, confirmLabel, onConfirm, onClose }: { anchor: Anchor; message: string; confirmLabel: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Popover anchor={anchor} onClose={onClose} label="Confirm" role="alertdialog" className="dbui-confirm">
      <p className="dbui-confirm-text">{message}</p>
      <div className="dbui-confirm-actions">
        <button type="button" className="dbui-btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="dbui-btn danger" data-autofocus onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
      </div>
    </Popover>
  );
}
