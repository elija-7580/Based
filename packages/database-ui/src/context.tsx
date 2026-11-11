// BSD-155: Zustand einer Datenbank-Ansicht: Store, QueryEngine, Version (nur Änderungen der eigenen
// Datenbank bzw. ihrer Relationsziele zählen – watchDatabase), Sperre und Rückrufe der Shell.
import type { AutofillWriter } from "./logic/autofill.js";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { QueryEngine, watchDatabase, weekStartForLocale, type Block, type Database, type DatabaseView, type WorkspaceStore } from "@based/core";
import { defaultIsAgentEdit } from "./logic/values.js";

export interface DBContextValue {
  store: WorkspaceStore;
  engine: QueryEngine;
  /** Steigt bei jeder Änderung, die diese Datenbank betrifft. */
  version: number;
  db: Database;
  /** Datenbank gesperrt oder `readOnly`: keine Schreiboperationen. */
  locked: boolean;
  onOpenPage: ((rowID: string) => void) | undefined;
  isAgentEdit: (row: Block) => boolean;
  /** Erster Wochentag für Kalender/Timeline (0 = Sonntag … 6 = Samstag): Einstellung der Shell, sonst Locale. */
  weekStart: number;
  /** BSD-213: Sammelaktionen der Shell für ausgewählte Zeilen (Tabs, Links); fehlen sie, gibt es die Knöpfe nicht. */
  rowActions: RowActions | undefined;
}

export interface RowActions {
  openInTabs?: ((rowIDs: string[]) => void) | undefined;
  copyLinks?: ((rowIDs: string[]) => void) | undefined;
}

export const DBContext = createContext<DBContextValue | null>(null);

/** Was die Shell für die Formular-Ansicht bekommt (gerendert im DBContext der Datenbank). */
export interface FormRenderProps {
  store: WorkspaceStore;
  db: Database;
  view: DatabaseView;
  locked: boolean;
  /** Anzahl der Antworten (Zeilen laut Filter der Ansicht). */
  responses: number;
}

/** Steckplatz der Shell für Oberflächen aus ihrem Komponenten-Baukasten (Formular). */
/**
 * BSD-208: Dateien für die Files-&-Media-Property. `upload` legt die Datei in den Asset-Speicher der Shell und gibt
 * ihre ID zurück; `open` liefert eine anzeigbare URL (Blob) zu einer Asset-ID.
 */
export interface FileHost {
  upload: (file: File) => Promise<string>;
  open: (assetID: string) => Promise<string>;
}

export const ShellSlots = createContext<{ renderForm?: ((p: FormRenderProps) => ReactNode) | undefined; files?: FileHost | undefined; ai?: AutofillWriter | undefined; databases?: DatabaseSource | undefined }>({});

/** BSD-216: andere Datenbanken des Workspaces (Dashboard-Quelle); `include` holt sie in den Store dieser Seite. */
export interface DatabaseSource {
  list(): Promise<{ id: string; title: string }[]>;
  include(id: string): Promise<boolean>;
}

export function useDB(): DBContextValue {
  const c = useContext(DBContext);
  if (!c) throw new Error("DBContext fehlt");
  return c;
}

/** Version, die nur bei Änderungen dieser Datenbank (oder ihrer Relationsziele) steigt. */
export function useDatabaseVersion(store: WorkspaceStore, databaseID: string): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    setVersion((v) => v + 1);
    return watchDatabase(store, databaseID, () => setVersion((v) => v + 1));
  }, [store, databaseID]);
  return version;
}

export interface ContextOptions {
  readOnly?: boolean | undefined;
  onOpenPage?: ((rowID: string) => void) | undefined;
  isAgentEdit?: ((row: Block) => boolean) | undefined;
  weekStart?: number | undefined;
  rowActions?: RowActions | undefined;
}

/** Baut den Kontext für eine Datenbank; `undefined`, wenn es sie (noch) nicht gibt. */
export function useDatabaseContext(store: WorkspaceStore, databaseID: string, opts: ContextOptions): DBContextValue | undefined {
  const version = useDatabaseVersion(store, databaseID);
  const engine = useMemo(() => new QueryEngine(store), [store]);
  // Neu rechnen nur bei betroffenen Änderungen: der Memo der Engine wird pro Version einmal geleert.
  useMemo(() => engine.reset(), [engine, version]);
  const db = store.databases.get(databaseID);
  const { readOnly, onOpenPage, isAgentEdit, rowActions } = opts;
  const weekStart = opts.weekStart !== undefined && opts.weekStart >= 0 && opts.weekStart <= 6 ? Math.floor(opts.weekStart) : weekStartForLocale();
  return useMemo(() => db && {
    store, engine, version, db, locked: readOnly === true || db.locked === true, onOpenPage, isAgentEdit: isAgentEdit ?? defaultIsAgentEdit, weekStart, rowActions,
  }, [store, engine, version, db, readOnly, onOpenPage, isAgentEdit, weekStart, rowActions]);
}

/**
 * BSD-255: Die Datenbank steht inline in einer Seite – ohne eigenen senkrechten Scroller, Zeilen begrenzt mit
 * „Load more“ (wie Notion). `null` = ganze Seite oder Peek.
 */
export const InlineView = createContext<{ pageSize: number } | null>(null);
/** Zeilen je Seite einer Inline-Tabelle (Notions Standard „Load limit“ für Inline-Datenbanken liegt bei 10–25). */
export const INLINE_PAGE_SIZE = 25;
