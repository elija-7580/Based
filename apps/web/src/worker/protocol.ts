// BSD-153: Nachrichten zwischen UI (Hauptthread) und Store-Worker. Der WorkspaceStore liegt im Worker (SQLite-WASM
// auf OPFS braucht einen Dedicated Worker); die UI bekommt Snapshots und Änderungen und schickt Befehle, die der
// Worker als Transaktionen ausführt. Alles hier ist strukturiert klonbar (keine Klassen, keine Funktionen).
import type { Block, DropZone, HistoryStats, HistoryVersion, Outline, RecordKeyString, WireRecord } from "@based/core";
import type { ImportPayload } from "./importer.js";
import type { ExportFormat, WorkspaceExportFormat } from "./interop.js";

export interface SyncConfig {
  url: string;
  token: string;
}

/** Zustand des Speichers und des Syncs, wie ihn die Seitenleiste zeigt. */
export type SyncState =
  | "starting"
  /** Kein Server eingestellt, Daten bleiben auf diesem Gerät. */
  | "local"
  | "syncing"
  | "synced"
  | "offline"
  | "error"
  /** Speichern gescheitert: Store schreibgeschützt (nie stiller RAM-Fallback). */
  | "readonly"
  /** Kein OPFS (z. B. privates Fenster) oder Datei in einem anderen Tab offen: nur im Speicher. */
  | "memory";

export interface StatusInfo {
  state: SyncState;
  /** Kurzer Text für Tooltip/Einstellungen (Fehlermeldung, letzte Runde …). */
  detail?: string;
  /** Daten liegen dauerhaft im OPFS. */
  persistent: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export type Command =
  | { op: "createPage"; parent?: string; section?: string; title?: string; after?: string }
  | { op: "createDatabase"; parent?: string; title?: string }
  | { op: "rename"; id: string; title: string }
  | { op: "trash"; ids: string[] }
  | { op: "restore"; ids: string[] }
  | { op: "deleteForever"; ids: string[] }
  | { op: "emptyTrash" }
  | { op: "drop"; ids: string[]; target: string; zone: DropZone }
  | { op: "moveToSection"; ids: string[]; section: string }
  | { op: "favorite"; ids: string[]; on: boolean }
  | { op: "undo" }
  | { op: "redo" }
  /** Testdaten: `count` Seiten mit je einem Absatz (E2E, Messungen). */
  | { op: "seed"; count: number; prefix?: string };

export interface QuickFindHit {
  pageID: string;
  title: string;
  /** Pfad über der Seite („Teamspace / Elternseite“). */
  path: string;
  snippet?: string;
  kind: "page" | "database" | "row";
}

export interface SearchResult {
  query: string;
  hits: QuickFindHit[];
  /** Rechenzeit im Worker (ms). */
  took: number;
}

/** Records einer offenen Seite (Seite, alles darin, eigene Datenbanken, Ansichten, Workspace). */
export interface PageRecords {
  pageID: string;
  node: string;
  records: WireRecord[];
}

/** Eine Seite für Erwähnungen, das @-Menü und Backlinks (Titel, Icon, Papierkorb). */
export interface PageInfo {
  id: string;
  title: string;
  icon?: string;
  kind: "page" | "database" | "row";
  /** Pfad über der Seite („Teamspace / Elternseite“); nur bei der Suche. */
  path?: string;
  /** Die Seite oder eine Seite über ihr liegt im Papierkorb. */
  trashed: boolean;
}

/** Antwort auf `includeSynced`: die Records des Originals (leer, wenn es das Original nicht gibt). */
export interface SyncedRecords {
  found: boolean;
  records: WireRecord[];
}

export type Request =
  | { type: "init"; device?: string; sync?: SyncConfig; opfs?: string }
  | { type: "command"; command: Command }
  | { type: "search"; query: string; limit?: number }
  | { type: "warmSearch" }
  | { type: "openPage"; pageID: string }
  | { type: "closePage"; pageID: string }
  /** Änderungen aus einer Seiten-Replik (Editor) übernehmen. */
  | { type: "applyLocal"; pageID: string; upserts: WireRecord[]; deletions: RecordKeyString[] }
  | { type: "setSync"; sync?: SyncConfig }
  | { type: "syncNow" }
  /** Im Import-Worker vorbereiteten Import schreiben (Antwort: ImportSummary). */
  | { type: "commitImport"; payload: ImportPayload; parent?: string }
  /** Exporte (Antwort: ExportFile). */
  | { type: "exportPage"; pageID: string; format: ExportFormat }
  | { type: "exportWorkspace"; format: WorkspaceExportFormat }
  /** Versionsverlauf einer Seite (BSD-73). */
  | { type: "history"; action: HistoryAction }
  /** Angaben zu Seiten (Antwort: Record<id, PageInfo | null>; `null` = gibt es nicht). */
  | { type: "pageInfo"; ids: string[] }
  /** Seitensuche fürs @-Menü, nur Titel (Antwort: PageInfo[]). Bricht keine Quick-Find-Suche ab. */
  | { type: "findPages"; query: string; limit?: number }
  /** Seiten, die `pageID` erwähnen oder verlinken (Antwort: PageInfo[]). */
  | { type: "backlinks"; pageID: string }
  /** Ein Synced-Block-Original (von einer anderen Seite) in die Replik von `pageID` aufnehmen (Antwort: SyncedRecords). */
  | { type: "includeSynced"; pageID: string; source: string };

export type HistoryAction =
  | { op: "list"; pageID: string }
  | { op: "content"; pageID: string; versionID: number }
  | { op: "restore"; pageID: string; versionID: number };

export interface HistoryList {
  /** Neueste zuerst; `at` in Unix-Sekunden. */
  versions: HistoryVersion[];
  stats?: HistoryStats;
  /** Speichern einer Version ist gescheitert (sichtbar statt verschluckt). */
  error?: string;
}

export interface HistoryContent {
  blocks: Block[];
  /** Fehlende Objekte: die Version ist unvollständig. */
  missing: string[];
}

export interface HistoryRestoreResult {
  restored: number;
  removed: number;
  /** Blöcke, die inzwischen auf einer anderen Seite stehen und hier als Kopie zurückkamen. */
  copied: number;
  trashed: number;
}

export type RequestMessage = Request & { id: number };

export interface InitResult {
  node: string;
  persistent: boolean;
  created: boolean;
  homePageID?: string;
}

export type Event =
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: string; cancelled?: boolean }
  /** Seitenleisten-Struktur (vollständig, nur wenn sie sich ändert). */
  | { type: "outline"; outline: Outline }
  /** Titel: vollständig (`full`) oder nur geänderte (`""` = gelöscht). */
  | { type: "titles"; titles: Record<string, string>; full: boolean }
  | { type: "status"; status: StatusInfo }
  /** Die Gerätekennung hat sich geändert (Hauptthread speichert sie in localStorage). */
  | { type: "device"; node: string }
  /** Änderungen an einer offenen Seite (für die Replik im Hauptthread). */
  | { type: "pageChanges"; pageID: string; upserts: WireRecord[]; deletions: RecordKeyString[] };

/** Was Worker und Hauptthread zum Reden brauchen (Worker, MessagePort oder ein Test-Kanal). */
export interface Endpoint<In, Out> {
  postMessage(msg: Out): void;
  addEventListener(type: "message", fn: (e: { data: In }) => void): void;
  removeEventListener(type: "message", fn: (e: { data: In }) => void): void;
}
