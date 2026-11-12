// BSD-154: Was die eigenen Blöcke vom Editor brauchen (Store, Callbacks der Shell), per React-Context.
import type { BookmarkMeta } from "@based/core";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { isTrashed, keyBetween, plainText, type Block, type WorkspaceStore } from "@based/core";
import type { MeetingHost } from "./meetingHost.js";
import type { DatabaseSource } from "./MovePicker.js";

export interface DatabaseRenderProps {
  /** Der Block `databaseInline` in der Seite. */
  blockID: string;
  databaseID: string;
  /** Aktive Ansicht (erste aus `props.viewIDs`), leer, wenn keine gesetzt ist. */
  viewID: string;
  viewIDs: readonly string[];
}

export interface EquationRenderProps {
  expression: string;
  /** Block-Gleichung (true) oder im Text (false). */
  displayMode: boolean;
}

export interface Person {
  id: string;
  name: string;
}

/** Eine Seite, wie Erwähnungen und das @-Menü sie brauchen. */
export interface PageRef {
  id: string;
  title: string;
  /** Emoji oder Symbolname. */
  icon?: string | undefined;
  kind?: "page" | "database" | "row" | undefined;
  /** Pfad über der Seite („Teamspace / Elternseite“), fürs Menü. */
  path?: string | undefined;
  /** Die Seite (oder eine Seite über ihr) liegt im Papierkorb. */
  trashed?: boolean | undefined;
  /** Die Seite gibt es nicht (mehr). */
  missing?: boolean | undefined;
}

/**
 * Seiten außerhalb des Dokuments: die Shell kennt alle Seiten (Titel, Icon, Papierkorb), der Editor nur die eigene.
 * `get` ist synchron und darf `undefined` liefern, solange die Angabe noch geladen wird; `subscribe` meldet, wenn
 * sich etwas geändert hat (Titel, Icon, Papierkorb).
 */
export interface PageDirectory {
  get(id: string): PageRef | undefined;
  subscribe(onChange: () => void): () => void;
  /** Seitensuche fürs @-Menü (läuft außerhalb des Hauptthreads); leere Eingabe: zuletzt benutzte Seiten. */
  search(query: string): Promise<PageRef[]>;
  /** „New page“ aus dem @-Menü: legt eine Seite an und gibt ihre ID zurück. Fehlt: kein solcher Eintrag. */
  create?: ((title: string) => Promise<string | undefined>) | undefined;
  /**
   * BSD-207 „Move to“: Sortierschlüssel des letzten Blocks auf einer Seite, damit bewegte Blöcke am Ende landen
   * (die Seiten-Replik kennt die Zielseite nicht). Fehlt: was der Store des Editors kennt.
   */
  lastChildKey?: ((pageID: string) => Promise<string | undefined>) | undefined;
}

export interface EditorEnv {
  store: WorkspaceStore;
  /** Wurzel dieses Editors (Seite oder Synced-Block-Original). */
  rootID: string;
  /** Wurzeln der umgebenden Editoren (gegen Endlos-Verschachtelung von Synced Blocks). */
  ancestors: readonly string[];
  renderDatabase?: ((p: DatabaseRenderProps) => ReactNode) | undefined;
  renderEquation?: ((p: EquationRenderProps) => ReactNode) | undefined;
  /** BSD-209: Bookmark-Vorschau holen (nur auf Klick, nur wo die Hülle das kann – Desktop-App). Ohne: kein Knopf. */
  fetchLinkPreview?: ((url: string) => Promise<BookmarkMeta>) | undefined;
  onOpenPage?: ((pageID: string) => void) | undefined;
  people?: readonly Person[] | undefined;
  /** Seiten des Workspaces (Erwähnungen, „Original auf Seite …“). */
  pages: PageDirectory;
  /** Bearbeitbar (sonst keine Aktionen in Blöcken). */
  editable: boolean;
  /** Kurzer Hinweis am Editor (z. B. „steht schon auf dieser Seite“). */
  notify: (message: string) => void;
  /** Zeigt den Inhalt eines Synced Blocks (ein eingebetteter Editor auf dessen Original). */
  renderSynced: (rootID: string, opts?: { readOnly?: boolean }) => ReactNode;
  /** BSD-226: Aufnahme/Wiedergabe/Zusammenfassung für Meeting-Blöcke; ohne: Block nur lesbar. */
  meeting?: MeetingHost | undefined;
  /** BSD-210: Datenbanken des Workspaces (Button „Add page to“); `include` holt eine in den Store des Editors. */
  databases: DatabaseSource;
  /** Ausstehende Editor-Änderungen sofort schreiben (z. B. bevor eine neue Unterseite geöffnet wird). */
  flush: () => void;
}

export const EnvContext = createContext<EditorEnv | null>(null);

export function useEnv(): EditorEnv {
  const env = useContext(EnvContext);
  if (!env) throw new Error("Based-Block ohne PageEditor");
  return env;
}

/** Neu rendern, wenn sich der Store ändert. */
export function useStoreRevision(store: WorkspaceStore): number {
  return useSyncExternalStore(
    (cb) => store.observe(() => cb()),
    () => store.revision,
  );
}

/** Ein Icon, das sich als Text zeichnen lässt (Emoji); Symbolnamen aus Swift („doc.text“) sind reines ASCII. */
export function isEmojiIcon(icon: string | undefined): icon is string {
  return icon !== undefined && [...icon].some((c) => c.codePointAt(0)! > 0xff);
}

/** Neu rendern, wenn das Seitenverzeichnis sich ändert; liefert die Angabe zu einer Seite. */
export function usePageRef(pages: PageDirectory, id: string): PageRef | undefined {
  // Der Schnappschuss ist ein String, damit React Gleichheit erkennt (get() darf jedes Mal ein neues Objekt liefern).
  useSyncExternalStore(pages.subscribe, () => {
    const p = pages.get(id);
    return p ? `${p.title}\u0001${p.icon ?? ""}\u0001${p.trashed ? 1 : 0}\u0001${p.missing ? 1 : 0}` : "";
  });
  return pages.get(id);
}

const titleOfBlock = (b: Block) => plainText(b.text).trim() || "Untitled";

function iconOf(b: Block): string | undefined {
  const icon = b.props?.icon;
  if (typeof icon === "string" && icon !== "") return icon;
  if (icon && typeof icon === "object" && "emoji" in icon && typeof icon.emoji === "string") return icon.emoji;
  return undefined;
}

/**
 * Verzeichnis nur aus dem Store des Editors (Testseite, Tests, Einbettung ohne Shell): kennt die Seiten, die im
 * Store liegen. Suche = Titel enthält die Eingabe.
 */
export function storePageDirectory(store: WorkspaceStore, opts: { parentForNew?: string } = {}): PageDirectory {
  const ref = (b: Block): PageRef => ({
    id: b.id, title: titleOfBlock(b), icon: iconOf(b), kind: b.type === "databasePage" ? "database" : b.parent.startsWith("d:") ? "row" : "page",
    trashed: isTrashed(store, b.id),
  });
  const isPage = (b: Block | undefined): b is Block => b?.type === "page" || b?.type === "databasePage";
  return {
    get(id) {
      const b = store.blocks.get(id);
      return isPage(b) ? ref(b) : { id, title: "", missing: true };
    },
    subscribe: (cb) => store.observe(() => cb()),
    async search(query) {
      const q = query.trim().toLowerCase();
      const out: PageRef[] = [];
      for (const b of store.blocks.values()) {
        if (!isPage(b) || isTrashed(store, b.id)) continue;
        if (q !== "" && !titleOfBlock(b).toLowerCase().includes(q)) continue;
        out.push(ref(b));
        if (out.length >= 8) break;
      }
      return out;
    },
    async create(title) {
      const id = globalThis.crypto.randomUUID().toUpperCase();
      const parent = opts.parentForNew ? "b:" + opts.parentForNew : "w";
      const last = store.children(parent).at(-1);
      const lastSk = last ? store.blocks.get(last)?.sk : undefined;
      store.transact("New page", (tx) => {
        const now = store.now();
        const b: Block = { id, type: "page", parent, sk: keyBetween(lastSk, undefined), createdAt: now, updatedAt: now };
        if (title.trim() !== "") b.text = title.trim();
        if (store.userID) b.createdBy = store.userID;
        tx.put({ kind: "block", data: b });
      });
      return id;
    },
  };
}
