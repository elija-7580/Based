// BSD-153: Nachrichten zwischen UI (Hauptthread) und Store-Worker. Der WorkspaceStore liegt im Worker (SQLite-WASM
// auf OPFS braucht einen Dedicated Worker); die UI bekommt Snapshots und Änderungen und schickt Befehle, die der
// Worker als Transaktionen ausführt. Alles hier ist strukturiert klonbar (keine Klassen, keine Funktionen).
import type { Block, DropZone, GraphFilter, HistoryStats, HistoryVersion, HybridPageContent, HybridStructureWire, Outline, PageGraph, RecordKeyString, SearchFilters, SearchSort, WireRecord } from "@based/core";
import type { ImportPayload } from "./importer.js";
import type { PageExportFormat, HTMLExportChoice, WorkspaceExportFormat } from "./interop.js";
import type { ChatAction } from "./chat.js";
import type { AgentAction } from "./agents.js";
import type { BrainAction } from "./brain.js";
import type { AgentSnapshot, ChatInfo } from "@based/brain";

export interface SyncConfig {
  url: string;
  token: string;
  /** BSD-220: Echtzeit-Text (Beta) – Seitentext über `/collab` (Yjs) abgleichen. Standard aus. */
  collab?: boolean;
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
  /** Dateien (BSD-78): nur gesetzt, wenn etwas aussteht oder gescheitert ist. */
  assets?: AssetsInfo;
  /** BSD-287: Zustand des Syncs selbst (auch wenn `state` „memory“ zeigt). */
  sync?: SyncState;
  /** BSD-286: Uhr dieses Geräts weicht von der Server-Uhr ab (Sekunden, Server minus Gerät); nur über der Grenze. */
  clockSkew?: number;
}

/** Stand der Datei-Übertragung für die Sync-Anzeige. */
export interface AssetsInfo {
  /** Noch hochzuladen. */
  uploads: number;
  downloads: number;
  /** Endgültig abgelehnt (zu groß für den Server). */
  failed: number;
  /** Warum Uploads gerade warten (`offline`, `unauthorized`, `unsupported` …). */
  paused?: string;
}

/** Referenz auf eine gespeicherte Datei (wie `AssetRef`; `id` = SHA-256 der Bytes). */
export interface AssetInfo {
  id: string;
  name: string;
  size: number;
  mime?: string;
}

/** Antwort auf `assetGet`: die Bytes, oder warum sie (noch) nicht da sind. */
export type AssetGetResult =
  | { ok: true; bytes: ArrayBuffer }
  | { ok: false; code: string; message: string };

export type Command =
  | { op: "createPage"; parent?: string; section?: string; title?: string; after?: string; format?: { font?: "default" | "serif" | "mono"; smallText?: boolean; fullWidth?: boolean } }
  | { op: "createDatabase"; parent?: string; title?: string }
  /** BSD-256: neue Seite „Meeting …“ mit einem Meeting-Block darin (⌘N → Meeting notes). */
  | { op: "createMeetingPage" }
  | { op: "rename"; id: string; title: string }
  | { op: "trash"; ids: string[] }
  | { op: "restore"; ids: string[] }
  | { op: "deleteForever"; ids: string[] }
  | { op: "emptyTrash" }
  | { op: "drop"; ids: string[]; target: string; zone: DropZone }
  | { op: "moveToSection"; ids: string[]; section: string }
  | { op: "favorite"; ids: string[]; on: boolean }
  /** Seiten in eine andere Seite verschieben (ans Ende). */
  | { op: "moveInto"; ids: string[]; parent: string }
  /** Seiten duplizieren (Antwort: IDs der Kopien). */
  | { op: "duplicate"; ids: string[] }
  /** Teamspaces: anlegen (Antwort: ID), umbenennen, Icon (Emoji oder keins), löschen (Seiten wandern nach Private). */
  | { op: "createTeamspace"; name: string; icon?: string }
  | { op: "renameTeamspace"; id: string; name: string }
  | { op: "renameWorkspace"; name: string }
  /** BSD-205: Emoji des Workspaces (ohne = entfernen). */
  | { op: "setWorkspaceIcon"; icon?: string }
  /** BSD-90: eine unverlinkte Erwähnung zur Seiten-Erwähnung machen. */
  | { op: "linkMention"; blockID: string; start: number; length: number; pageID: string }
  | { op: "setTeamspaceIcon"; id: string; icon?: string }
  | { op: "deleteTeamspace"; id: string }
  | { op: "undo" }
  | { op: "redo" }
  /** Testdaten: `count` Seiten mit je einem Absatz (E2E, Messungen). */
  | { op: "seed"; count: number; prefix?: string }
  /** BSD-215 (Tests): Datenbankseite mit `count` Zeilen. */
  | { op: "seedDatabase"; count: number }
  /** BSD-278 (Tests): Datenbank „Due tasks“ (Status + Datum) mit offenen und erledigten Zeilen für heute. */
  | { op: "seedDueTasks" };

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

/** BSD-90: eine unverlinkte Erwähnung mit dem Titel der Seite, in der sie steht. */
export interface UnlinkedMentionInfo {
  blockID: string;
  pageID: string;
  pageTitle: string;
  snippet: string;
  start: number;
  length: number;
}

/** BSD-281: ein Meeting für den Library-Reiter „Meetings“. */
export interface MeetingListItem {
  meetingID: string;
  pageID: string;
  title: string;
  pageTitle: string;
  status: string;
  /** ms seit 1970 (Beginn der Aufnahme, sonst Anlegen). */
  atMs: number;
  /** Sekunden, falls aufgenommen. */
  duration?: number;
}

/** BSD-212: eine Datenbank für die Auswahl „Linked view of database“. */
export interface DatabaseInfo {
  id: string;
  title: string;
  /** Liegt inline auf einer Seite (sonst eigene Datenbankseite). */
  inline: boolean;
  /** Pfad über dem Datenbank-Block. */
  path?: string;
}

export type Request =
  | { type: "init"; device?: string; sync?: SyncConfig; opfs?: string }
  | { type: "command"; command: Command }
  | { type: "search"; query: string; limit?: number; filters?: SearchFilters; sort?: SearchSort }
  | { type: "warmSearch" }
  | { type: "openPage"; pageID: string }
  | { type: "closePage"; pageID: string }
  /** Änderungen aus einer Seiten-Replik (Editor) übernehmen. */
  | { type: "applyLocal"; pageID: string; upserts: WireRecord[]; deletions: RecordKeyString[]; derived?: boolean }
  | { type: "setSync"; sync?: SyncConfig }
  | { type: "syncNow" }
  /** Im Import-Worker vorbereiteten Import schreiben (Antwort: ImportSummary). */
  | { type: "commitImport"; payload: ImportPayload; parent?: string }
  /** BSD-254: eine Datei eines laufenden Imports sofort ablegen (vorläufige ID → Hash; `commitImport` schreibt um). */
  | { type: "importAsset"; assetID: string; name: string; mime?: string; bytes: Uint8Array }
  /** BSD-283: abgebrochener Import – schon abgelegte Dateien wieder entfernen (nur neue, nur unbenutzte). */
  | { type: "discardImport" }
  /** BSD-317: Hybrid-Notion-Import – Struktur schreiben, Warteschlange lesen, Seiteninhalt einsetzen (packages/core, notion-hybrid). */
  | { type: "hybridStructure"; wire: HybridStructureWire; parent?: string }
  | { type: "hybridPending" }
  | { type: "hybridContent"; batch: HybridPageContent[] }
  /** Exporte (Antwort: ExportFile). */
  | { type: "exportPage"; pageID: string; format: PageExportFormat; html?: HTMLExportChoice }
  | { type: "exportWorkspace"; format: WorkspaceExportFormat; html?: HTMLExportChoice }
  /** Druckansicht einer Seite (Antwort: PrintDocument). */
  | { type: "printPage"; pageID: string; css?: string }
  /** Library: alle Einträge (Antwort: LibraryItem[]); gefiltert und sortiert wird im Hauptthread. */
  | { type: "library" }
  /** Seitengraph, im Worker gebaut und zugeschnitten (Antwort: GraphResult). */
  | { type: "graph"; filter?: GraphFilter }
  /** Versionsverlauf einer Seite (BSD-73). */
  | { type: "history"; action: HistoryAction }
  /** Datei speichern und zum Hochladen vormerken (Antwort: AssetInfo). */
  | { type: "assetPut"; name: string; mime?: string; bytes: ArrayBuffer }
  /** Bytes einer Datei: lokal oder vom Sync-Server (Antwort: AssetGetResult). */
  | { type: "assetGet"; asset: string }
  /** Angaben zu Seiten (Antwort: Record<id, PageInfo | null>; `null` = gibt es nicht). */
  | { type: "pageInfo"; ids: string[] }
  /** Seitensuche fürs @-Menü, nur Titel (Antwort: PageInfo[]). Bricht keine Quick-Find-Suche ab. */
  | { type: "findPages"; query: string; limit?: number }
  /** Seiten, die `pageID` erwähnen oder verlinken (Antwort: PageInfo[]). */
  | { type: "backlinks"; pageID: string }
  /** Ein Synced-Block-Original (von einer anderen Seite) in die Replik von `pageID` aufnehmen (Antwort: SyncedRecords). */
  | { type: "includeSynced"; pageID: string; source: string }
  /** BSD-212: Datenbank (Record + Zeilen) für eine verknüpfte Ansicht in die Replik von `pageID` (Antwort: SyncedRecords). */
  | { type: "includeDatabase"; pageID: string; databaseID: string }
  /** BSD-212: Datenbanken nach Titel (Antwort: DatabaseInfo[]). */
  | { type: "listDatabases"; query: string }
  /** BSD-281: alle Meeting-Blöcke (Antwort: MeetingListItem[], neueste zuerst). */
  | { type: "meetings" }
  /** BSD-90: Stellen, an denen der Titel der Seite als reiner Text vorkommt (Antwort: UnlinkedMentionInfo[]). */
  | { type: "unlinkedMentions"; pageID: string }
  /** BSD-278: fällige, offene Datenbank-Zeilen im Fenster (Antwort: DueItem[] aus @based/brain/home). */
  | { type: "dueItems"; fromMs: number; toMs: number }
  /** Chats, Transkripte und Agent-Werkzeuge (BSD-159, worker/chat.ts). */
  | { type: "chat"; action: ChatAction }
  /** Aufträge, Runs, Projekte, Zeitpläne des Hauptagenten (BSD-195/196/160, worker/agents.ts). */
  | { type: "agents"; action: AgentAction }
  /** Agent Brain: Skills, Memories, Skill-Router, Zitate, lokaler Index (BSD-163/198, worker/brain.ts). */
  | { type: "brain"; action: BrainAction }
  /** BSD-220: gespeicherter Y-Zustand einer Dokument-Wurzel (Antwort: Uint8Array | null). */
  | { type: "ydocLoad"; rootID: string }
  /** BSD-252: hat die Seite lokale Änderungen, die noch nicht beim Server sind? */
  | { type: "pendingLocal"; rootID: string }
  /** BSD-220: Y-Zustand einer Dokument-Wurzel speichern (Antwort: true). */
  | { type: "ydocSave"; rootID: string; state: Uint8Array };

export interface GraphResult {
  graph: PageGraph;
  /** Größe des ganzen Graphs vor dem Zuschnitt. */
  totalNodes: number;
  totalEdges: number;
  /** Rechenzeit im Worker (ms). */
  took: number;
}

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
  /** Die Chat-Liste hat sich geändert (lokal, anderer Tab oder Sync). */
  | { type: "chats"; chats: ChatInfo[] }
  /** Agenten-Records haben sich geändert (lokal, anderer Tab oder Sync). */
  | { type: "agents"; snapshot: AgentSnapshot }
  /** Änderungen an einer offenen Seite (für die Replik im Hauptthread). */
  | { type: "pageChanges"; pageID: string; upserts: WireRecord[]; deletions: RecordKeyString[] };

/** Was Worker und Hauptthread zum Reden brauchen (Worker, MessagePort oder ein Test-Kanal). */
export interface Endpoint<In, Out> {
  postMessage(msg: Out): void;
  addEventListener(type: "message", fn: (e: { data: In }) => void): void;
  removeEventListener(type: "message", fn: (e: { data: In }) => void): void;
}
