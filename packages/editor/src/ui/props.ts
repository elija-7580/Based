// Props des Seiten-Editors (Block-Editor, ADR 0016). Bis BSD-407 Teil 4 lagen sie beim alten BlockNote-Editor.
import type { BookmarkMeta, WorkspaceStore } from "@based/core";
import type { ReactNode } from "react";
import type { BoardEmbed } from "../whiteboard/BoardView.js";
import type { CollabSource } from "../yjs/collab.js";
import type { DatabaseRenderProps, EquationRenderProps, PageDirectory, Person } from "./env.js";
import type { MeetingHost } from "./meetingHost.js";
import type { DatabaseSource } from "./MovePicker.js";
import type { EditorAI } from "./ai.js";

export interface PageEditorProps {
  store: WorkspaceStore;
  /** Die Seite (Block `page` oder `databasePage`), deren Inhalt der Editor zeigt. */
  pageID: string;
  /** Zeichnet eine eingebettete Datenbank-Ansicht (anderes Paket). Ohne: Platzhalter. */
  renderDatabase?: (p: DatabaseRenderProps) => ReactNode;
  /** Elija 17.11.: ein Board als Unterseite erscheint in der Seite als Fläche (bearbeitbar), nicht nur als Link. */
  renderBoard?: (p: { blockID: string; pageID: string; embed?: BoardEmbed }) => ReactNode;
  /** Zeichnet eine Gleichung (KaTeX, eigener Eintrag). Ohne: TeX als Code. */
  renderEquation?: (p: EquationRenderProps) => ReactNode;
  /**
   * BSD-407 (neuer Editor): Inline-Gleichung als HTML für die Textfelder. `undefined`, solange der Renderer noch lädt;
   * dann ruft die Hülle `onReady` auf, sobald er da ist.
   */
  renderEquationHTML?: (expression: string, onReady: () => void) => string | undefined;
  /** BSD-209: Bookmark-Vorschau holen (Desktop-App über Tauri-HTTP, nur auf Klick „Fetch preview“). */
  fetchLinkPreview?: (url: string) => Promise<BookmarkMeta>;
  /** Klick auf Unterseite, Seitenlink oder Seiten-Erwähnung. */
  onOpenPage?: (pageID: string) => void;
  /** Personen für @-Erwähnungen. */
  people?: readonly Person[];
  /** Alle Seiten des Workspaces (Suche im @-Menü, Titel/Icon/Papierkorb von Erwähnungen). Ohne: nur der Store. */
  pages?: PageDirectory;
  /**
   * Einen Synced Block von einer anderen Seite in den Store holen (Seiten-Repliken kennen nur ihre Seite).
   * Liefert `false`, wenn es ihn nicht gibt. Ohne: der Store muss ihn schon enthalten.
   */
  loadSynced?: (sourceID: string) => Promise<boolean>;
  /** BSD-101: Link auf einen Block (für „Copy link to block“). Ohne: kein Menüpunkt. */
  blockLink?: ((blockID: string) => string) | undefined;
  /** BSD-101: zu diesem Block springen und ihn kurz hervorheben (Link auf einen Block geöffnet). */
  focusBlock?: string | undefined;
  /** Schwebende Gliederung am rechten Rand (Standard: an; pro Seite über `props.format.hideOutline` abschaltbar). */
  outline?: boolean;
  /** BSD-220: Echtzeit-Text über `/collab` (Seiten-Wurzeln); ohne: nur Records + Sync. */
  collab?: CollabSource;
  /** ADR 0016 (E7): Name, unter dem die anderen einen in der Seite sehen (Präsenz im neuen Editor). */
  presenceName?: string;
  /** Standard: bearbeitbar, solange der Store nicht schreibgeschützt ist. */
  editable?: boolean;
  /** `based-asset:<id>`- und andere URLs für Medien auflösen. */
  resolveFileUrl?: (url: string) => Promise<string>;
  uploadFile?: (file: File, blockId?: string) => Promise<string>;
  theme?: "light" | "dark";
  className?: string;
  /** BSD-226: Aufnahme, Wiedergabe und Zusammenfassung für Meeting-Blöcke (`/meet`). */
  meeting?: MeetingHost;
  /**
   * BSD-207: Unterseiten und Datenbanken (Blöcke mit eigenen Records) tief kopieren, Kopie direkt hinter dem Original.
   * Ohne: `duplicatePages` auf dem Store des Editors (der muss dann alles darin kennen).
   */
  duplicatePages?: (ids: string[]) => Promise<unknown>;
  /**
   * BSD-212: Datenbanken für „Linked view of database“ (alle im Workspace) und das Nachladen der gewählten in den
   * Store. Ohne: die Datenbanken, die der Store des Editors kennt.
   */
  databases?: DatabaseSource;
  /** BSD-225: „Ask AI“ (leere Zeile + Leertaste, /AI, Formatleiste). Ohne: keine AI-Einträge. */
  ai?: EditorAI;
  /** Beta-Gate: Blocktypen, die das Slash-Menü nicht anbietet (vorhandene Blöcke bleiben sichtbar). */
  hiddenBlocks?: ReadonlySet<string>;
}
