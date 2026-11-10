// Zeile als Seite im Peek (Notion „Open pages in“): Side Peek = Astryx-Drawer ohne Scrim (die Ansicht dahinter bleibt
// bedienbar), Center Peek = Astryx-Dialog. Inhalt: Titel, Property-Liste (@based/database-ui), Seiteninhalt im
// Editor-Steckplatz. Welche Zeile offen ist und die Reihenfolge fürs Blättern kommen aus @based/database-ui.
import { createContext, useEffect, useRef, useState } from "react";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { plainText } from "@based/core";
import { RowProperties, type PeekRenderProps } from "@based/database-ui";
import { BlockView } from "../components/BlockView.js";
import { slots } from "../slots.js";
import { DbIcon } from "./icons.js";
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

function Body({ p }: { p: Props }) {
  if (!p.row || p.row.trashedAt !== undefined) return <p className="t-desc row-peek-gone" role="status">This page was deleted.</p>;
  const Editor = slots.PageEditor;
  const readOnly = p.readOnly || p.locked;
  return (
    <InPeek.Provider value={true}>
      <div className="row-peek-body" data-testid="row-peek" data-row-id={p.rowID} data-mode={p.mode} tabIndex={-1} data-autofocus="">
        <Title p={p} />
        <RowProperties rowID={p.rowID} />
        <div className="row-peek-content" data-testid="row-peek-content">
          {Editor
            ? <Editor key={p.rowID} store={p.store} pageID={p.rowID} readOnly={readOnly} onOpenPage={p.onOpenPage} />
            : <BlockView key={p.rowID} store={p.store} pageID={p.rowID} readOnly={readOnly} onOpenPage={p.onOpenPage} />}
        </div>
      </div>
    </InPeek.Provider>
  );
}

export function RowPeek(p: Props) {
  // Erst geschlossen einhängen, dann öffnen: so meldet sich die Hülle auch dann sauber an (Escape, Fokus), wenn der
  // Peek nach dem Neuladen schon beim ersten Rendern offen ist.
  const [isOpen, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);
  const onOpenChange = (open: boolean) => { if (!open) p.onClose(); };
  const position = p.index >= 0 ? `${(p.index + 1).toLocaleString("en-US")} of ${p.total.toLocaleString("en-US")}` : "Not in this view";
  const nav = (
    <span className="row-peek-nav">
      <IconButton label="Previous page" tooltip="Previous page (⌃⇧↑)" variant="ghost" size="sm" icon={<DbIcon name="up" />} isDisabled={!p.onPrev} onClick={() => p.onPrev?.()} />
      <IconButton label="Next page" tooltip="Next page (⌃⇧↓)" variant="ghost" size="sm" icon={<DbIcon name="down" />} isDisabled={!p.onNext} onClick={() => p.onNext?.()} />
    </span>
  );
  const full = p.onOpenFull
    ? <IconButton label="Open as full page" tooltip="Open as full page" variant="ghost" size="sm" icon={<DbIcon name="expand" />} onClick={() => p.onOpenFull?.()} />
    : null;
  const subtitle = <span className="row-peek-position" data-testid="row-peek-position">{position}</span>;
  const content = <LayoutContent><Body p={p} /></LayoutContent>;
  if (p.mode === "centerPeek") {
    return (
      <Dialog isOpen={isOpen} onOpenChange={onOpenChange} width="min(60rem, 92vw)" maxHeight="88dvh">
        <Layout header={<DialogHeader title={p.databaseTitle} subtitle={subtitle} startContent={nav} endContent={full} onOpenChange={onOpenChange} />} content={content} />
      </Dialog>
    );
  }
  return (
    <Drawer isOpen={isOpen} onOpenChange={onOpenChange} label={`${p.databaseTitle}: page`} hasScrim={false} width="min(46rem, 60vw)">
      <Layout header={<DrawerHeader title={p.databaseTitle} subtitle={subtitle} startContent={nav} endContent={full} onOpenChange={onOpenChange} />} content={content} />
    </Drawer>
  );
}
