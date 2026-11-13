// Zeile als Seite im Peek (Notion „Open pages in“): Side Peek = Astryx-Drawer ohne Scrim (die Ansicht dahinter bleibt
// bedienbar), Center Peek = Astryx-Dialog. Inhalt: Titel, Property-Liste (@based/database-ui), Seiteninhalt im
// Editor-Steckplatz. Welche Zeile offen ist und die Reihenfolge fürs Blättern kommen aus @based/database-ui.
import { createContext, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as RPointerEvent } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { plainText } from "@based/core";
import { RowProperties, type PeekRenderProps } from "@based/database-ui";
import { BlockView } from "../components/BlockView.js";
import { slots } from "../slots.js";
import { Icon } from "../icons.js";
import { peekWidthPref } from "../shell/storage.js";
import "./rowPeek.css";

/** Im Peek geöffnete Inline-Datenbanken öffnen ihre Zeilen als ganze Seite (keine Peeks in Peeks). */
export const InPeek = createContext(false);

interface Props extends PeekRenderProps {
  databaseTitle: string;
  readOnly: boolean;
  onOpenPage: (id: string) => void;
}

function Title({ p }: { p: Props }) {
  const stored = p.row ? plainText(p.row.text) : "";
  const [value, setValue] = useState(stored);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setValue(stored); }, [stored, p.rowID]);
  return (
    <h1 className="t-title row-peek-title">
      <input className="title-input" aria-label="Row title" placeholder="Untitled" value={value} readOnly={p.readOnly || p.locked}
        onFocus={() => (focused.current = true)} onBlur={() => (focused.current = false)}
        onChange={(e) => { setValue(e.target.value); p.store.setText(p.rowID, e.target.value); }}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
    </h1>
  );
}

/**
 * Beim schnellen Blättern (⌃⇧↑/↓ gehalten) den Editor erst einhängen, wenn man kurz auf einer Seite bleibt: Titel
 * und Properties wechseln sofort, der Editoraufbau (BlockNote) bremst das Blättern sonst spürbar.
 */
function useSettledRow(rowID: string, delay = 180): string {
  const [settled, setSettled] = useState(rowID);
  useEffect(() => {
    if (settled === rowID) return;
    const t = setTimeout(() => setSettled(rowID), delay);
    return () => clearTimeout(t);
  }, [rowID, settled, delay]);
  return settled;
}

function Body({ p }: { p: Props }) {
  const settled = useSettledRow(p.rowID);
  // BSD-238: per Tastatur geöffnet (Fokus noch im Raster oder nirgends): Fokus in den Peek, damit Esc und Tab dort wirken.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const a = document.activeElement;
    if (!a || a === document.body || a.getAttribute("role") === "grid") bodyRef.current?.focus({ preventScroll: true });
  }, []);
  if (!p.row || p.row.trashedAt !== undefined) return <p className="t-desc row-peek-gone" role="status">This page was deleted.</p>;
  const Editor = slots.PageEditor;
  const readOnly = p.readOnly || p.locked;
  return (
    <InPeek.Provider value={true}>
      <div ref={bodyRef} className="row-peek-body" data-testid="row-peek" data-row-id={p.rowID} data-mode={p.mode} tabIndex={-1} data-autofocus="">
        <Title p={p} />
        <RowProperties rowID={p.rowID} />
        <div className="row-peek-content" data-testid="row-peek-content">
          {settled !== p.rowID
            ? <p className="t-desc row-peek-loading" aria-busy="true">Opening…</p>
            : Editor
              ? <Editor key={p.rowID} store={p.store} pageID={p.rowID} readOnly={readOnly} onOpenPage={p.onOpenPage} />
              : <BlockView key={p.rowID} store={p.store} pageID={p.rowID} readOnly={readOnly} onOpenPage={p.onOpenPage} />}
        </div>
      </div>
    </InPeek.Provider>
  );
}

/** BSD-373: Breite des Side Peek in px (pro Gerät gemerkt): mindestens so breit wie eine Spalte Text, höchstens 90 %. */
export const PEEK_MIN = 420;
export const clampPeekWidth = (w: number, viewport: number): number => Math.round(Math.max(Math.min(PEEK_MIN, viewport * 0.9), Math.min(w, viewport * 0.9)));

/** Etwas, das Esc zuerst schließen soll (Menü, Popover, anderer Dialog), ist offen. */
function overlayOpen(): boolean {
  return !!document.querySelector("[role=menu], [role=listbox], .bn-suggestion-menu, .bn-ak-popover, .dbui-popover, .bx-emoji, dialog[open]:not(:has(.row-peek-body))");
}

/**
 * BSD-373: Esc schließt den Peek – Reihenfolge: erst Menü/Popover, dann Blockauswahl, dann Peek. Im Editor macht das
 * erste Esc aus der Schreibmarke eine Blockauswahl (wie Notion); das nächste schließt jetzt den Peek, statt zwischen
 * Schreibmarke und Blockauswahl hin und her zu springen. Auch mit dem Fokus in der Ansicht dahinter.
 */
function usePeekEscape(close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const peek = document.querySelector(".row-peek-body");
      if (!peek || overlayOpen()) return;
      const t = e.target instanceof Element ? e.target : null;
      const inPeek = !!t && peek.contains(t);
      if (inPeek) {
        const doc = t.closest(".bx-doc");
        // Schreibmarke im Text: das Esc gehört dem Editor (macht eine Blockauswahl).
        if (doc && !doc.hasAttribute("data-block-selection")) return;
        if (t.closest("input, textarea, select") && !t.matches(".title-input")) return;
      } else {
        // Fokus dahinter: Felder und die Tabelle (Esc hebt dort erst Auswahl/Bearbeitung auf) haben Vorrang.
        if (e.defaultPrevented || (t && t.closest("input, textarea, select, [contenteditable=true], [role=grid] .dbui-cell.active"))) return;
      }
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
}

/** Griff am linken Rand des Side Peek: Ziehen ändert die Breite, Doppelklick setzt sie zurück. */
function ResizeHandle({ width, onWidth }: { width: number; onWidth: (w: number | undefined) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const down = (e: RPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
  };
  const move = (e: RPointerEvent<HTMLSpanElement>) => {
    const s = start.current;
    if (s) onWidth(clampPeekWidth(s.w + (s.x - e.clientX), window.innerWidth));
  };
  const up = () => { start.current = null; };
  return (
    <span className="row-peek-resize" role="separator" aria-orientation="vertical" aria-label="Resize page" data-testid="row-peek-resize"
      tabIndex={0} aria-valuenow={width} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      onDoubleClick={() => onWidth(undefined)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 20;
        if (e.key === "ArrowLeft") { e.preventDefault(); onWidth(clampPeekWidth(width + step, window.innerWidth)); }
        else if (e.key === "ArrowRight") { e.preventDefault(); onWidth(clampPeekWidth(width - step, window.innerWidth)); }
      }} />
  );
}

/** Standardbreite wie bisher: min(46rem, 60vw). */
const defaultPeekWidth = () => Math.min(46 * 16, window.innerWidth * 0.6);

export function RowPeek(p: Props) {
  // Erst geschlossen einhängen, dann öffnen: so meldet sich die Hülle auch dann sauber an (Escape, Fokus), wenn der
  // Peek nach dem Neuladen schon beim ersten Rendern offen ist.
  const [isOpen, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);
  const onOpenChange = (open: boolean) => { if (!open) p.onClose(); };
  usePeekEscape(p.onClose);
  const stored = useSyncExternalStore(peekWidthPref.subscribe, peekWidthPref.get);
  const width = clampPeekWidth(stored ?? defaultPeekWidth(), window.innerWidth);
  const position = p.index >= 0 ? `${(p.index + 1).toLocaleString("en-US")} of ${p.total.toLocaleString("en-US")}` : "Not in this view";
  const nav = (
    <span className="row-peek-nav">
      <IconButton label="Previous page" tooltip="Previous page (⌃⇧↑)" variant="ghost" size="sm" icon={<Icon name="up" size={16} />} isDisabled={!p.onPrev} onClick={() => p.onPrev?.()} />
      <IconButton label="Next page" tooltip="Next page (⌃⇧↓)" variant="ghost" size="sm" icon={<Icon name="down" size={16} />} isDisabled={!p.onNext} onClick={() => p.onNext?.()} />
    </span>
  );
  const full = p.onOpenFull
    ? <IconButton label="Open as full page" tooltip="Open as full page" variant="ghost" size="sm" icon={<Icon name="expand" size={16} />} onClick={() => p.onOpenFull?.()} />
    : null;
  const subtitle = <span className="row-peek-position" data-testid="row-peek-position">{position}</span>;
  const content = <LayoutContent><Body p={p} /></LayoutContent>;
  const sideContent = <LayoutContent><ResizeHandle width={width} onWidth={(w) => peekWidthPref.set(w)} /><Body p={p} /></LayoutContent>;
  if (p.mode === "centerPeek") {
    return (
      <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width="min(60rem, 92vw)" maxHeight="88dvh">
        <Layout header={<DialogHeader title={p.databaseTitle} subtitle={subtitle} startContent={nav} endContent={full} onOpenChange={onOpenChange} />} content={content} />
      </Dialog>
    );
  }
  return (
    <Drawer isOpen={isOpen} onOpenChange={onOpenChange} label={`${p.databaseTitle}: page`} hasScrim={false} width={`${width}px`}>
      <Layout header={<DrawerHeader title={p.databaseTitle} subtitle={subtitle} startContent={nav} endContent={full} onOpenChange={onOpenChange} />} content={sideContent} />
    </Drawer>
  );
}
