// Library: alles im Workspace auf einen Blick – Seiten, Datenbanken, Zeilen – mit Suche, Filtern (Art, Ort, Favoriten,
// gleicher Titel), Sortierung und Mehrfachauswahl für Verschieben, Duplizieren, Favorisieren und Papierkorb.
// Vorlage: Swift App/Shared/Views/Library/LibraryView.swift. Die Einträge kommen aus dem Store-Worker
// (`client.library()`), gefiltert und sortiert wird hier mit `filterLibrary` aus @based/core; die Liste ist
// virtualisiert (nur sichtbare Zeilen im DOM).
import { LibraryTabs } from "../components/LibraryTabs.js";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { DropdownMenu, type DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { duplicateTitleKeys, filterLibrary, type LibraryItem, type LibraryKind, type LibraryQuery, type LibrarySort } from "@based/core";
import { VirtualList } from "@based/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { MoveDialog } from "../components/MoveDialog.js";
import { Icon, type IconName } from "../icons.js";
import { fromSwift, relative } from "../shell/format.js";
import type { ShellState, StoreClient } from "../worker/client.js";
import "./library.css";

const KIND_LABEL: Record<LibraryKind, string> = { page: "Page", database: "Database", row: "Row" };
const KIND_ICON: Record<LibraryKind, IconName> = { page: "page", database: "database", row: "page" };
const TYPE_FILTERS: { id: string; label: string; kinds: LibraryKind[] }[] = [
  { id: "all", label: "All types", kinds: [] },
  { id: "pages", label: "Pages", kinds: ["page"] },
  { id: "databases", label: "Databases", kinds: ["database"] },
  { id: "rows", label: "Rows", kinds: ["row"] },
  { id: "containers", label: "Pages and databases", kinds: ["page", "database"] },
];
const SORTS: { id: LibrarySort; label: string }[] = [
  { id: "edited", label: "Last edited" },
  { id: "created", label: "Created" },
  { id: "title", label: "Title" },
];
/** Richtung, mit der eine Sortierung anfängt: Daten neueste zuerst, Titel A→Z. */
const defaultAscending = (s: LibrarySort) => s === "title";

function rowHeight(): number {
  if (typeof document === "undefined") return 40;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-7"));
  return Number.isFinite(v) && v > 0 ? v : 40;
}

const check = <Icon name="check" size={16} />;
const none = <span className="lib-nocheck" aria-hidden="true" />;

interface Props {
  client: StoreClient;
  state: ShellState;
  onOpenPage: (id: string) => void;
  /** BSD-281: Reiter Pages/Graph. */
  onSwitch?: (to: "library" | "graph" | "meetings") => void;
}

export function Library({ client, state, onOpenPage, onSwitch }: Props) {
  const [items, setItems] = useState<LibraryItem[] | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [text, setText] = useState("");
  const [type, setType] = useState("all");
  const [section, setSection] = useState<string | undefined>();
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [sameTitle, setSameTitle] = useState(false);
  const [sort, setSort] = useState<LibrarySort>("edited");
  const [ascending, setAscending] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [moving, setMoving] = useState(false);
  const [confirmTrash, setConfirmTrash] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const anchor = useRef<string | undefined>(undefined);
  const height = useMemo(rowHeight, []);

  // Einträge laden und bei Änderungen der Struktur oder der Titel nachladen (kurz gesammelt).
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      client.library().then((list) => alive && (setItems(list), setFailed(undefined)), (e: Error) => alive && setFailed(e.message));
    }, items === undefined ? 0 : 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [client, state.outline, state.titles]);

  const sections = state.outline?.sections ?? [];
  // Der gewählte Teamspace kann inzwischen gelöscht sein
  const activeSection = section !== undefined && sections.some((s) => s.id === section) ? section : undefined;
  const query: LibraryQuery = useMemo(() => {
    const q: LibraryQuery = { text, kinds: TYPE_FILTERS.find((t) => t.id === type)?.kinds ?? [], favoritesOnly, onlyDuplicateTitles: sameTitle, sort, ascending };
    if (activeSection !== undefined) q.section = activeSection;
    return q;
  }, [text, type, activeSection, favoritesOnly, sameTitle, sort, ascending]);
  const rows = useMemo(() => filterLibrary(items ?? [], query), [items, query]);
  const duplicates = useMemo(() => (items ? duplicateTitleKeys(items).size : 0), [items]);

  // Auswahl: nur, was es noch gibt
  useEffect(() => {
    if (!items || selected.size === 0) return;
    const have = new Set(items.map((i) => i.id));
    if ([...selected].some((id) => !have.has(id))) setSelected(new Set([...selected].filter((id) => have.has(id))));
  }, [items]);

  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);
  const ids = useMemo(() => [...selected], [selected]);
  const allVisible = rows.length > 0 && selectedRows.length === rows.length;
  const filtered = text.trim() !== "" || type !== "all" || activeSection !== undefined || favoritesOnly || sameTitle;

  const toggle = useCallback((id: string, range: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const a = anchor.current;
      if (range && a !== undefined && a !== id) {
        const i = rows.findIndex((r) => r.id === a), j = rows.findIndex((r) => r.id === id);
        if (i >= 0 && j >= 0) {
          for (let k = Math.min(i, j); k <= Math.max(i, j); k++) next.add(rows[k]!.id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
  }, [rows]);

  const clearFilters = () => {
    setType("all");
    setSection(undefined);
    setFavoritesOnly(false);
    setSameTitle(false);
  };

  const run = async (label: string, f: () => Promise<unknown>, keepSelection = false) => {
    try {
      await f();
      setNotice(label);
      if (!keepSelection) setSelected(new Set());
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
  };
  const n = ids.length;
  const things = (k: number) => `${k} ${k === 1 ? "item" : "items"}`;
  const allFavorite = n > 0 && items !== undefined && ids.every((id) => items.find((i) => i.id === id)?.favorite);
  const trash = () => run(`Moved ${things(n)} to Trash.`, () => client.command({ op: "trash", ids }));

  const typeItems: DropdownMenuOption[] = TYPE_FILTERS.map((t) => ({ id: t.id, label: t.label, icon: type === t.id ? check : none, onClick: () => setType(t.id) }));
  const locationItems: DropdownMenuOption[] = [
    { id: "any", label: "Anywhere", icon: activeSection === undefined ? check : none, onClick: () => setSection(undefined) },
    { type: "divider" },
    ...sections.map((s) => ({ id: s.id, label: s.name, icon: activeSection === s.id ? check : none, onClick: () => setSection(s.id) })),
  ];
  const sortItems: DropdownMenuOption[] = [
    ...SORTS.map((s) => ({ id: s.id, label: s.label, icon: sort === s.id ? check : none, onClick: () => { setSort(s.id); setAscending(defaultAscending(s.id)); } })),
    { type: "divider" },
    { id: "asc", label: sort === "title" ? "A to Z" : "Oldest first", icon: ascending ? check : none, onClick: () => setAscending(true) },
    { id: "desc", label: sort === "title" ? "Z to A" : "Newest first", icon: !ascending ? check : none, onClick: () => setAscending(false) },
  ];
  const typeLabel = TYPE_FILTERS.find((t) => t.id === type)?.label ?? "All types";
  const locationLabel = activeSection === undefined ? "Anywhere" : (sections.find((s) => s.id === activeSection)?.name ?? "Anywhere");
  const sortLabel = SORTS.find((s) => s.id === sort)?.label ?? "Last edited";

  const now = new Date();
  const renderRow = (i: number, style: CSSProperties) => {
    const item = rows[i]!;
    const isSelected = selected.has(item.id);
    const onRowClick = (e: MouseEvent<HTMLDivElement>) => {
      // Klick auf die Zeile wählt aus (Umschalt = Bereich); der Titel öffnet.
      if ((e.target as HTMLElement).closest("button, input, label, a")) return;
      toggle(item.id, e.shiftKey);
    };
    return (
      <div role="listitem" aria-label={item.title} className={"lib-row" + (isSelected ? " selected" : "")} style={style} data-id={item.id} onClick={onRowClick}>
        <span className="lib-check" onClick={(e) => { if (e.shiftKey) { e.preventDefault(); toggle(item.id, true); } }}>
          <CheckboxInput label={`Select ${item.title}`} isLabelHidden size="sm" value={isSelected} onChange={() => toggle(item.id, false)} />
        </span>
        <span className="lib-icon" aria-hidden="true">{item.icon ?? <Icon name={KIND_ICON[item.kind]} size={16} />}</span>
        <button type="button" className="lib-title link-button" title={item.title} onClick={() => onOpenPage(item.id)}>
          <span className="lib-title-text">{item.title}</span>
          {item.favorite ? <span className="lib-fav" role="img" aria-label="Favorite"><Icon name="star" size={14} filled /></span> : null}
        </button>
        <span className="lib-kind t-desc">{KIND_LABEL[item.kind]}</span>
        <span className="lib-location t-desc" title={item.location}>{item.location}</span>
        <span className="lib-date t-data">{relative(fromSwift(item.edited), now)}</span>
        <span className="lib-date t-data">{relative(fromSwift(item.created), now)}</span>
      </div>
    );
  };

  const total = items?.length ?? 0;
  return (
    <div className="lib" data-testid="library" data-count={rows.length} data-loaded={items ? "" : undefined}>
      <header className="lib-head">
        {onSwitch ? <LibraryTabs value="library" onNavigate={onSwitch} /> : null}
        <h1 className="t-title">Library</h1>
        <p className="t-desc" role="status" aria-live="polite" data-testid="library-count">
          {items === undefined ? "Loading…" : filtered ? `${rows.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} items` : `${total.toLocaleString("en-US")} ${total === 1 ? "item" : "items"}`}
          {notice ? ` · ${notice}` : ""}
        </p>
      </header>

      <Toolbar
        label="Library filters"
        size="sm"
        className="lib-toolbar"
        startContent={<TextInput type="search" label="Search the library" isLabelHidden placeholder="Search by title or location" value={text} onChange={setText} hasClear width={280} />}
        endContent={
          <>
            <DropdownMenu button={{ label: `Type: ${typeLabel}`, variant: "ghost" }} items={typeItems} menuWidth={220} alignment="end" />
            <DropdownMenu button={{ label: `In: ${locationLabel}`, variant: "ghost" }} items={locationItems} menuWidth={220} alignment="end" />
            <ToggleButton label="Favorites" icon={<Icon name="star" size={16} />} isPressed={favoritesOnly} onPressedChange={setFavoritesOnly} />
            <ToggleButton label="Same title" icon={<Icon name="duplicate" size={16} />} isPressed={sameTitle} onPressedChange={setSameTitle} tooltip={duplicates > 0 ? `${duplicates} ${duplicates === 1 ? "title is" : "titles are"} used more than once` : "No title is used more than once"} />
            <DropdownMenu button={{ label: `Sort: ${sortLabel}`, variant: "ghost" }} items={sortItems} menuWidth={200} alignment="end" />
          </>
        }
      />

      {n > 0 ? (
        <Toolbar
          label="Selection"
          size="sm"
          className="lib-bulk"
          startContent={
            <>
              <IconButton label="Clear selection" variant="ghost" icon={<Icon name="close" size={16} />} onClick={() => setSelected(new Set())} />
              <strong data-testid="library-selected">{n} selected</strong>
            </>
          }
          endContent={
            <>
              <Button label="Move to…" variant="ghost" icon={<Icon name="move" size={16} />} onClick={() => setMoving(true)} />
              <Button label="Duplicate" variant="ghost" icon={<Icon name="duplicate" size={16} />} onClick={() => void run(`Duplicated ${things(n)}.`, () => client.command({ op: "duplicate", ids }), true)} />
              <Button label={allFavorite ? "Remove from Favorites" : "Add to Favorites"} variant="ghost" icon={<Icon name="star" size={16} />} onClick={() => void run(allFavorite ? `Removed ${things(n)} from Favorites.` : `Added ${things(n)} to Favorites.`, () => client.command({ op: "favorite", ids, on: !allFavorite }), true)} />
              <Button label="Move to Trash" variant="ghost" icon={<Icon name="trash" size={16} />} onClick={() => (n > 1 ? setConfirmTrash(true) : void trash())} />
            </>
          }
        />
      ) : null}

      <div className="lib-table">
        <div className="lib-row lib-columns t-meta">
          <span className="lib-check">
            <CheckboxInput label="Select all" isLabelHidden size="sm" isDisabled={rows.length === 0} value={allVisible ? true : selectedRows.length > 0 ? "indeterminate" : false}
              onChange={() => setSelected(allVisible ? new Set() : new Set(rows.map((r) => r.id)))} />
          </span>
          <span className="lib-icon" />
          <span className="lib-title">Name</span>
          <span className="lib-kind">Type</span>
          <span className="lib-location">Location</span>
          <span className="lib-date">Edited</span>
          <span className="lib-date">Created</span>
        </div>
        {failed ? (
          <p role="alert" className="dialog-error lib-empty">Couldn't load the library: {failed}</p>
        ) : items !== undefined && rows.length === 0 ? (
          <div className="lib-empty">
            <EmptyState
              isCompact
              title={total === 0 ? "Nothing here yet" : "Nothing matches"}
              description={total === 0 ? "Pages, databases and rows you create show up here." : "Try a different search or clear the filters."}
              {...(filtered && total > 0 ? { actions: <Button label="Clear search and filters" onClick={() => { setText(""); clearFilters(); }} /> } : {})}
            />
          </div>
        ) : (
          <VirtualList className="lib-list" role="list" aria-label="Library items" count={rows.length} rowHeight={height} rowKey={(i) => rows[i]!.id} renderRow={renderRow} overscan={12} />
        )}
      </div>

      {moving && state.outline ? (
        <MoveDialog client={client} state={state} ids={ids} onClose={() => setMoving(false)} onMoved={(t) => {
          setNotice(`Moved ${things(n)} to ${t.label}.`);
          setSelected(new Set());
        }} />
      ) : null}
      <AlertDialog
        isOpen={confirmTrash}
        onOpenChange={setConfirmTrash}
        title={`Move ${things(n)} to Trash?`}
        description="Sub-pages go with their parent. You can undo this or restore them from Trash."
        actionLabel="Move to Trash"
        onAction={() => {
          setConfirmTrash(false);
          void trash();
        }}
      />
    </div>
  );
}
