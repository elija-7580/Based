// BSD-153: Steckplätze für Editor (@based/editor) und Datenbank-Ansichten (@based/database-ui). Bis die Pakete
// fertig sind, zeigt die Shell eine Lese-Darstellung bzw. einen Platzhalter. Anschließen in main.tsx, z. B.:
//
//   import { PageEditor } from "@based/editor";
//   registerSlots({ PageEditor });
//
// Beide bekommen `store`: die Replik der offenen Seite im Hauptthread – ein vollwertiger WorkspaceStore mit der
// Seite und allem darin (Unterblöcke, eigene Datenbanken, deren Zeilen und Ansichten). Änderungen über
// `store.transact(...)`, `setText`, `undo()` usw. speichert der Worker (OPFS) und synct sie; Änderungen von
// anderswo kommen per `applyRemote` an (Herkunft "remote" in `store.observe`).
import type { ComponentType } from "react";
import type { WorkspaceStore } from "@based/core";

export interface PageEditorProps {
  /** Replik der Seite (siehe oben). */
  store: WorkspaceStore;
  /** Die Seite (Block vom Typ `page`); ihre Kinder sind der Inhalt. */
  pageID: string;
  /** Schreibgeschützt (Seite im Papierkorb oder Speichern gescheitert). */
  readOnly: boolean;
  /** Link auf eine andere Seite öffnen (Erwähnung, Unterseite, Link-to-page). */
  onOpenPage: (pageID: string) => void;
}

export interface DatabaseViewProps {
  store: WorkspaceStore;
  /** Block der Datenbankseite (`databasePage`) bzw. der Inline-Datenbank. */
  blockID: string;
  databaseID: string;
  readOnly: boolean;
  onOpenPage: (pageID: string) => void;
}

export interface Slots {
  PageEditor?: ComponentType<PageEditorProps>;
  DatabaseView?: ComponentType<DatabaseViewProps>;
}

export const slots: Slots = {};

export function registerSlots(s: Slots) {
  Object.assign(slots, s);
}
