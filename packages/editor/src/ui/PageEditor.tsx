// BSD-154: Der Seiten-Editor. BlockNote-Kern auf einem Y.Doc je Seite (bzw. je Synced-Block-Original), Records
// im Store als materialisierte Ansicht. Undo/Redo lokal über den Yjs-UndoManager.
import "@blocknote/ariakit/style.css";
import "../styles.css";
import "../meeting.css";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { filterSuggestionItems, SideMenuExtension } from "@blocknote/core/extensions";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/ariakit";
import {
  BlockColorsItem, DragHandleMenu, FormattingToolbar, FormattingToolbarController, getDefaultReactSlashMenuItems,
  getFormattingToolbarItems, RemoveBlockItem, SideMenu, SideMenuController, SuggestionMenuController,
  useBlockNoteEditor, useComponentsContext, useExtensionState, type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { createMeeting, keysBetween, syncedOriginal, syncedPasteProblem, type SyncedPasteProblem, type WorkspaceStore } from "@based/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CUSTOM, INLINE, SYNC_CLIPBOARD_PREFIX, syncSourceFromClipboard } from "../mapping/bn.js";
import { basedSchema, sharedConverter, type BasedEditor } from "../schema/schema.js";
import { acquireSession, releaseSession, type DocSession, type YDocStore } from "../yjs/session.js";
import { EnvContext, storePageDirectory, type DatabaseRenderProps, type EditorEnv, type EquationRenderProps, type PageDirectory, type Person } from "./env.js";
import type { MeetingHost } from "./meetingHost.js";
import { mentionItems } from "./mentions.js";
import { PageOutline } from "./Outline.js";
import { handlePaste } from "./paste.js";
import { lastCopiedSync, rememberSyncClipboard } from "./syncClipboard.js";

export interface PageEditorProps {
  store: WorkspaceStore;
  /** Die Seite (Block `page` oder `databasePage`), deren Inhalt der Editor zeigt. */
  pageID: string;
  /** Zeichnet eine eingebettete Datenbank-Ansicht (anderes Paket). Ohne: Platzhalter. */
  renderDatabase?: (p: DatabaseRenderProps) => ReactNode;
  /** Zeichnet eine Gleichung (KaTeX, eigener Eintrag). Ohne: TeX als Code. */
  renderEquation?: (p: EquationRenderProps) => ReactNode;
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
  /** Schwebende Gliederung am rechten Rand (Standard: an; pro Seite über `props.format.hideOutline` abschaltbar). */
  outline?: boolean;
  /** Ablage der Y-Zustände; ohne: im Speicher (pro Store). */
  docStore?: YDocStore;
  /** Standard: bearbeitbar, solange der Store nicht schreibgeschützt ist. */
  editable?: boolean;
  /** `based-asset:<id>`- und andere URLs für Medien auflösen. */
  resolveFileUrl?: (url: string) => Promise<string>;
  uploadFile?: (file: File, blockId?: string) => Promise<string>;
  theme?: "light" | "dark";
  className?: string;
  /** BSD-226: Aufnahme, Wiedergabe und Zusammenfassung für Meeting-Blöcke (`/meet`). */
  meeting?: MeetingHost;
}

interface Shared extends Omit<PageEditorProps, "pageID" | "className" | "pages"> {
  docStore: YDocStore;
  pages: PageDirectory;
  pageID: string;
  notify: (message: string) => void;
}

const memoryDocStores = new WeakMap<WorkspaceStore, YDocStore>();
function defaultDocStore(store: WorkspaceStore): YDocStore {
  let s = memoryDocStores.get(store);
  if (!s) {
    const states = new Map<string, Uint8Array>();
    s = { load: (id) => states.get(id), save: (id, st) => void states.set(id, st) };
    memoryDocStores.set(store, s);
  }
  return s;
}

const directories = new WeakMap<WorkspaceStore, PageDirectory>();
function defaultDirectory(store: WorkspaceStore): PageDirectory {
  let d = directories.get(store);
  if (!d) directories.set(store, (d = storePageDirectory(store)));
  return d;
}

export function PageEditor(props: PageEditorProps) {
  const { pageID, className, ...rest } = props;
  const [notice, setNotice] = useState<string | undefined>();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useCallback((message: string) => {
    setNotice(message);
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(undefined), 6000);
  }, []);
  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
  }, []);
  const shared: Shared = {
    ...rest, pageID, notify,
    docStore: props.docStore ?? defaultDocStore(props.store),
    pages: props.pages ?? defaultDirectory(props.store),
  };
  return (
    <div className={"bx-editor " + (className ?? "")} data-page={pageID} ref={setContainer}>
      <DocEditor rootID={pageID} ancestors={[]} shared={shared} />
      {props.outline === false ? null : <PageOutline store={props.store} pageID={pageID} container={container} />}
      {notice ? (
        <div className="bx-notice" role="status" data-testid="editor-notice">
          <span>{notice}</span>
          <button type="button" className="bx-notice-close" aria-label="Dismiss" onClick={() => setNotice(undefined)}>×</button>
        </div>
      ) : null}
    </div>
  );
}

/** Ein Editor auf einer Dokument-Wurzel (Seite oder Synced-Block-Original). */
function DocEditor(props: { rootID: string; ancestors: readonly string[]; shared: Shared; readOnly?: boolean }) {
  const { store, docStore } = props.shared;
  const [session, setSession] = useState<DocSession>();
  useEffect(() => {
    const s = acquireSession(store, props.rootID, { converter: sharedConverter(), docStore });
    setSession(s);
    return () => releaseSession(s);
  }, [store, props.rootID, docStore]);
  if (!session || session.store !== store || session.rootID !== props.rootID) return null;
  return <BoundEditor key={props.rootID} session={session} ancestors={props.ancestors} shared={props.shared} readOnly={props.readOnly === true} />;
}

/** ⇧⌘V / Ctrl+Shift+V: der Browser liefert dann nur `text/plain` – nicht von normalem Einfügen zu unterscheiden. */
const PLAIN_PASTE_WINDOW_MS = 1000;

function BoundEditor(props: { session: DocSession; ancestors: readonly string[]; shared: Shared; readOnly: boolean }) {
  const { session, shared } = props;
  const { store } = shared;
  const editorRef = useRef<BasedEditor | null>(null);
  const plainPasteAt = useRef(0);
  const sharedRef = useRef(shared);
  sharedRef.current = shared;
  const ancestorsRef = useRef(props.ancestors);
  ancestorsRef.current = props.ancestors;
  const editor = useMemo((): BasedEditor => {
    const options = withCollaboration({
      schema: basedSchema(),
      collaboration: { fragment: session.fragment, user: { name: store.userID ?? "me", color: "var(--muted)" } },
      ...(shared.resolveFileUrl ? { resolveFileUrl: shared.resolveFileUrl } : {}),
      ...(shared.uploadFile ? { uploadFile: shared.uploadFile } : {}),
      pasteHandler: ({ event, defaultPasteHandler }: { event: ClipboardEvent; defaultPasteHandler: (c?: { prioritizeMarkdownOverHTML?: boolean; plainTextAsMarkdown?: boolean }) => boolean | undefined }): boolean => {
        const ed = editorRef.current;
        if (!ed) return defaultPasteHandler() ?? false;
        const plainOnly = Date.now() - plainPasteAt.current < PLAIN_PASTE_WINDOW_MS;
        plainPasteAt.current = 0;
        if (!plainOnly && pasteSynced(ed, session, event, ancestorsRef.current, sharedRef.current)) return true;
        return handlePaste(ed, { event, defaultPasteHandler, plainOnly });
      },
    });
    return BlockNoteEditor.create(options) as unknown as BasedEditor;
  }, [session]);
  editorRef.current = editor;
  useEffect(() => () => void session.flush(), [editor, session]);

  const editable = !props.readOnly && (shared.editable ?? !store.isReadOnly);
  const env: EditorEnv = {
    store,
    rootID: session.rootID,
    ancestors: props.ancestors,
    renderDatabase: shared.renderDatabase,
    renderEquation: shared.renderEquation,
    onOpenPage: shared.onOpenPage,
    people: shared.people,
    pages: shared.pages,
    editable,
    notify: shared.notify,
    meeting: shared.meeting,
    flush: () => session.flush(),
    renderSynced: (root, opts) => (
      <div className="bx-synced-editor">
        <DocEditor rootID={root} ancestors={[...props.ancestors, session.rootID]} shared={shared} readOnly={props.readOnly || opts?.readOnly === true} />
      </div>
    ),
  };
  const mentionOptions = { pages: shared.pages, people: shared.people ?? [], selfID: shared.pageID };

  return (
    <EnvContext.Provider value={env}>
      <div className="bx-doc" onKeyDownCapture={(e) => {
        if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") plainPasteAt.current = Date.now();
      }}>
        <BlockNoteView editor={editor} editable={editable} slashMenu={false} sideMenu={false} formattingToolbar={false}
          {...(shared.theme ? { theme: shared.theme } : {})} data-root={session.rootID}>
          <SuggestionMenuController triggerCharacter="/" getItems={async (q) => filterSuggestionItems(slashItems(editor, session, props.ancestors, shared), q)} />
          <SuggestionMenuController triggerCharacter="@" getItems={(q) => mentionItems(editor, q, mentionOptions)} />
          <SuggestionMenuController triggerCharacter="[[" getItems={(q) => mentionItems(editor, q, { ...mentionOptions, pagesOnly: true })} />
          <SideMenuController sideMenu={(p) => <SideMenu {...p} dragHandleMenu={() => <BlockMenu session={session} />} />} />
          <FormattingToolbarController formattingToolbar={() => (
            <FormattingToolbar>
              {getFormattingToolbarItems().filter((item) => !String(item.key).startsWith("textAlign"))}
            </FormattingToolbar>
          )} />
        </BlockNoteView>
      </div>
    </EnvContext.Provider>
  );
}

// MARK: Slash-Menü

function slashItems(editor: BasedEditor, session: DocSession, ancestors: readonly string[], shared: Shared): DefaultReactSuggestionItem[] {
  const insert = (block: PartialBlock<never, never, never>) => {
    const cur = editor.getTextCursorPosition().block;
    const empty = Array.isArray(cur.content) && cur.content.length === 0 && cur.type === "paragraph";
    if (empty) editor.replaceBlocks([cur], [block as never]);
    else editor.insertBlocks([block as never], cur, "after");
  };
  const columns = (n: number) => ({
    type: CUSTOM.columnList,
    children: Array.from({ length: n }, () => ({ type: CUSTOM.column, children: [{ type: "paragraph" }] })),
  });
  const custom: DefaultReactSuggestionItem[] = [
    { title: "Callout", subtext: "Make writing stand out.", aliases: ["note", "info", "tip"], group: "Basic blocks", onItemClick: () => insert({ type: CUSTOM.callout } as never) },
    { title: "Page", subtext: "Embed a sub-page inside this page.", aliases: ["subpage", "new page"], group: "Basic blocks", onItemClick: () => insert({ type: CUSTOM.page } as never) },
    { title: "Link to page", subtext: "Link to an existing page.", aliases: ["link"], group: "Basic blocks", onItemClick: () => insert({ type: CUSTOM.linkToPage } as never) },
    { title: "Synced block", subtext: "Sync content across pages.", aliases: ["sync"], group: "Advanced blocks", onItemClick: () => insert({ type: CUSTOM.syncedBlock } as never) },
    { title: "Database – Inline", subtext: "Add a database view to this page.", aliases: ["table view", "database"], group: "Database", onItemClick: () => insert({ type: CUSTOM.database } as never) },
    { title: "Block equation", subtext: "Display a standalone math equation.", aliases: ["math", "tex", "latex", "equation"], group: "Advanced blocks", onItemClick: () => insert({ type: CUSTOM.equation } as never) },
    { title: "Inline equation", subtext: "Insert a math equation in the text.", aliases: ["math", "tex", "latex", "equation", "inline"], group: "Advanced blocks", onItemClick: () => insertInlineEquation(editor) },
    { title: "Meeting notes", subtext: "Record a meeting, take timestamped notes, get a summary.", aliases: ["meet", "meeting", "transcribe", "record", "notes"], group: "Advanced blocks", onItemClick: () => insertMeeting(editor, session) },
    { title: "Table of contents", subtext: "Show an outline of this page.", aliases: ["toc", "outline"], group: "Advanced blocks", onItemClick: () => insert({ type: CUSTOM.toc } as never) },
    { title: "Breadcrumb", subtext: "Show where this page sits.", aliases: ["path"], group: "Advanced blocks", onItemClick: () => insert({ type: CUSTOM.breadcrumb } as never) },
    { title: "2 columns", subtext: "Two columns side by side.", aliases: ["columns", "layout"], group: "Advanced blocks", onItemClick: () => insert(columns(2) as never) },
    { title: "3 columns", subtext: "Three columns side by side.", aliases: ["columns", "layout"], group: "Advanced blocks", onItemClick: () => insert(columns(3) as never) },
    { title: "Web bookmark", subtext: "Save a link as a visual bookmark.", aliases: ["bookmark", "url"], group: "Media", onItemClick: () => insert({ type: CUSTOM.embed, props: { kind: "bookmark" } } as never) },
    { title: "Embed", subtext: "Embed a link.", aliases: ["iframe"], group: "Media", onItemClick: () => insert({ type: CUSTOM.embed, props: { kind: "embed" } } as never) },
    { title: "PDF", subtext: "Embed a PDF.", aliases: ["pdf"], group: "Media", onItemClick: () => insert({ type: CUSTOM.embed, props: { kind: "pdf" } } as never) },
  ];
  const copied = syncSourceFromClipboard(lastCopiedSync() ?? "");
  if (copied) {
    custom.push({
      title: "Paste synced block", subtext: "Insert the block you copied with “Copy and sync”.", aliases: ["sync", "paste"], group: "Advanced blocks",
      onItemClick: () => void pasteSyncedSource(editor, session, copied, ancestors, shared),
    });
  }
  const defaults = getDefaultReactSlashMenuItems(editor).filter((i) => !/^(Heading [56]|Toggle Heading [56]|Emoji|Page Break)$/i.test(i.title));
  return [...defaults, ...custom];
}

/**
 * BSD-226: Meeting-Block einfügen. Erst die Records (Meeting mit Notiz- und Zusammenfassungs-Abschnitt) still in den
 * Store, dann der Block mit derselben ID ins Dokument – der Editor übernimmt Elternteil und Sortierschlüssel.
 */
export function insertMeeting(editor: BasedEditor, session: DocSession): string {
  session.flush();
  const id = globalThis.crypto.randomUUID().toUpperCase();
  session.quietly(() => createMeeting(session.store, { parent: "b:" + session.rootID, id, undoable: false }));
  const cur = editor.getTextCursorPosition().block;
  const block = { id, type: CUSTOM.meeting } as never;
  const empty = cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0 && cur.children.length === 0;
  if (empty) editor.replaceBlocks([cur], [block]);
  else editor.insertBlocks([block], cur, "after");
  // Ein leerer Absatz danach, damit man unter dem Block weiterschreiben kann.
  if (editor.document[editor.document.length - 1]?.id === id) {
    editor.insertBlocks([{ type: "paragraph" } as never], id, "after");
  }
  return id;
}

/** Gleichung im Text an der Schreibmarke einfügen (leer: öffnet ihr Eingabefeld). */
export function insertInlineEquation(editor: BasedEditor, expression = "") {
  editor.insertInlineContent([{ type: INLINE.equation, props: { expression, text: "" } } as never]);
}

// MARK: Block-Menü mit „Copy and sync“

function BlockMenu(props: { session: DocSession }) {
  return (
    <DragHandleMenu>
      <RemoveBlockItem>Delete</RemoveBlockItem>
      <BlockColorsItem>Colors</BlockColorsItem>
      <CopyAndSyncItem session={props.session} />
    </DragHandleMenu>
  );
}

function CopyAndSyncItem(props: { session: DocSession }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as BasedEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  if (!block) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => {
      const selected = editor.getSelection()?.blocks;
      const ids = selected && selected.some((b) => b.id === block.id) ? selected.map((b) => b.id) : [block.id];
      void copyAndSync(editor, props.session, ids);
    }}>
      Copy and sync
    </Components.Generic.Menu.Item>
  );
}

/**
 * „Copy and sync“ (wie in Notion): die Blöcke werden zu einem Synced Block (Original), dessen Verweis in die
 * Zwischenablage kommt. Einfügen auf einer anderen Seite erzeugt eine synchronisierte Kopie.
 * Ein Undo-Schritt im Editor. Gibt die ID des Originals zurück.
 */
export async function copyAndSync(editor: BasedEditor, session: DocSession, blockIDs: readonly string[]): Promise<string | undefined> {
  const { store } = session;
  const first = editor.getBlock(blockIDs[0]!);
  if (!first) return undefined;
  let original: string;
  if (blockIDs.length === 1 && first.type === CUSTOM.syncedBlock) {
    original = (first.props as { source?: string }).source || first.id;
  } else {
    session.flush();
    const recs = blockIDs.map((id) => store.blocks.get(id));
    const head = recs[0];
    if (!head || recs.some((r) => !r || r.parent !== head.parent)) return undefined; // nur Geschwister
    original = globalThis.crypto.randomUUID();
    const keys = keysBetween(blockIDs.length, undefined, undefined);
    session.quietly(() => store.transact("Copy and sync", (tx) => {
      const now = store.now();
      tx.put({ kind: "block", data: { id: original, type: "syncedBlock", parent: head.parent, sk: head.sk, createdAt: now, updatedAt: now, ...(store.userID ? { createdBy: store.userID } : {}) } });
      blockIDs.forEach((id, i) => tx.update(id, (b) => {
        b.parent = "b:" + original;
        b.sk = keys[i]!;
      }));
    }, { undoable: false }));
    editor.replaceBlocks([...blockIDs], [{ id: original, type: CUSTOM.syncedBlock } as never]);
  }
  const text = SYNC_CLIPBOARD_PREFIX + original;
  rememberSyncClipboard(text);
  try {
    await globalThis.navigator?.clipboard?.writeText(text);
  } catch {
    /* ohne Berechtigung: lastSyncClipboard */
  }
  return original;
}

const PASTE_PROBLEMS: Record<SyncedPasteProblem, string> = {
  noSource: "That synced block no longer exists.",
  alreadyOnPage: "This synced block is already on this page.",
  insideItself: "A synced block can't be placed inside itself.",
};

/** Einfügen von `based-sync:<id>` erzeugt eine synchronisierte Kopie hinter dem aktuellen Block. */
function pasteSynced(editor: BasedEditor, session: DocSession, event: ClipboardEvent, ancestors: readonly string[], shared: Shared): boolean {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  const src = syncSourceFromClipboard(text);
  if (!src) return false;
  void pasteSyncedSource(editor, session, src, ancestors, shared);
  return true;
}

/** Verweis prüfen (ggf. das Original erst von einer anderen Seite holen), dann einfügen oder den Grund melden. */
async function pasteSyncedSource(editor: BasedEditor, session: DocSession, source: string, ancestors: readonly string[], shared: Shared): Promise<void> {
  if (!session.store.blocks.has(source) && shared.loadSynced) {
    try {
      await shared.loadSynced(source);
    } catch { /* unten: noSource */ }
  }
  const problem = insertSyncedCopy(editor, session, source, ancestors);
  if (problem) shared.notify(PASTE_PROBLEMS[problem]);
}

/**
 * Synchronisierte Kopie eines Synced Blocks einfügen (wie Swift `pasteSyncedCopy`). Gibt den Grund zurück, wenn
 * das nicht geht: unbekannte Quelle, in sich selbst, oder derselbe Block steht schon in diesem Dokument.
 */
export function insertSyncedCopy(editor: BasedEditor, session: DocSession, source: string, ancestors: readonly string[] = []): SyncedPasteProblem | undefined {
  session.flush();
  const problem = syncedPasteProblem(session.store, source, session.rootID, ancestors);
  if (problem) return problem;
  const original = syncedOriginal(session.store, source)!;
  const cur = editor.getTextCursorPosition().block;
  const copy = { type: CUSTOM.syncedBlock, props: { source: original } } as never;
  const empty = cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0 && cur.children.length === 0;
  if (empty) editor.replaceBlocks([cur], [copy]);
  else editor.insertBlocks([copy], cur, "after");
  return undefined;
}

export { lastCopiedSync };
