// BSD-154: Der Seiten-Editor. BlockNote-Kern auf einem Y.Doc je Seite (bzw. je Synced-Block-Original), Records
// im Store als materialisierte Ansicht. Undo/Redo lokal über den Yjs-UndoManager.
import "@blocknote/ariakit/style.css";
import "../styles.css";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { filterSuggestionItems, SideMenuExtension } from "@blocknote/core/extensions";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/ariakit";
import {
  BlockColorsItem, DragHandleMenu, FormattingToolbar, FormattingToolbarController, getDefaultReactSlashMenuItems,
  getFormattingToolbarItems, RemoveBlockItem, SideMenu, SideMenuController, SuggestionMenuController,
  useBlockNoteEditor, useComponentsContext, useExtensionState, type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { canonicalStringify, dateToSwift, keysBetween, type WorkspaceStore } from "@based/core";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CUSTOM, INLINE, SYNC_CLIPBOARD_PREFIX, syncSourceFromClipboard } from "../mapping/bn.js";
import { basedSchema, sharedConverter, type BasedEditor } from "../schema/schema.js";
import { pageIcon, pageTitle } from "../schema/blocks.js";
import { acquireSession, releaseSession, type DocSession, type YDocStore } from "../yjs/session.js";
import { EnvContext, type DatabaseRenderProps, type EditorEnv, type EquationRenderProps, type Person } from "./env.js";

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
  /** Ablage der Y-Zustände; ohne: im Speicher (pro Store). */
  docStore?: YDocStore;
  /** Standard: bearbeitbar, solange der Store nicht schreibgeschützt ist. */
  editable?: boolean;
  /** `based-asset:<id>`- und andere URLs für Medien auflösen. */
  resolveFileUrl?: (url: string) => Promise<string>;
  uploadFile?: (file: File, blockId?: string) => Promise<string>;
  theme?: "light" | "dark";
  className?: string;
}

interface Shared extends Omit<PageEditorProps, "pageID" | "className"> {
  docStore: YDocStore;
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

export function PageEditor(props: PageEditorProps) {
  const { pageID, className, ...rest } = props;
  const shared: Shared = { ...rest, docStore: props.docStore ?? defaultDocStore(props.store) };
  return (
    <div className={"bx-editor " + (className ?? "")} data-page={pageID}>
      <DocEditor rootID={pageID} ancestors={[]} shared={shared} />
    </div>
  );
}

/** Ein Editor auf einer Dokument-Wurzel (Seite oder Synced-Block-Original). */
function DocEditor(props: { rootID: string; ancestors: readonly string[]; shared: Shared }) {
  const { store, docStore } = props.shared;
  const [session, setSession] = useState<DocSession>();
  useEffect(() => {
    const s = acquireSession(store, props.rootID, { converter: sharedConverter(), docStore });
    setSession(s);
    return () => releaseSession(s);
  }, [store, props.rootID, docStore]);
  if (!session || session.store !== store || session.rootID !== props.rootID) return null;
  return <BoundEditor key={props.rootID} session={session} ancestors={props.ancestors} shared={props.shared} />;
}

function BoundEditor(props: { session: DocSession; ancestors: readonly string[]; shared: Shared }) {
  const { session, shared } = props;
  const { store } = shared;
  const editorRef = useRef<BasedEditor | null>(null);
  const editor = useMemo((): BasedEditor => {
    const options = withCollaboration({
      schema: basedSchema(),
      collaboration: { fragment: session.fragment, user: { name: store.userID ?? "me", color: "var(--muted)" } },
      ...(shared.resolveFileUrl ? { resolveFileUrl: shared.resolveFileUrl } : {}),
      ...(shared.uploadFile ? { uploadFile: shared.uploadFile } : {}),
      pasteHandler: ({ event, defaultPasteHandler }: { event: ClipboardEvent; defaultPasteHandler: () => boolean | undefined }): boolean =>
        (editorRef.current !== null && pasteSynced(editorRef.current, session, event)) || (defaultPasteHandler() ?? false),
    });
    return BlockNoteEditor.create(options) as unknown as BasedEditor;
  }, [session]);
  editorRef.current = editor;
  useEffect(() => () => void session.flush(), [editor, session]);

  const env: EditorEnv = {
    store,
    rootID: session.rootID,
    ancestors: props.ancestors,
    renderDatabase: shared.renderDatabase,
    renderEquation: shared.renderEquation,
    onOpenPage: shared.onOpenPage,
    people: shared.people,
    flush: () => session.flush(),
    renderSynced: (root) => (
      <div className="bx-synced-editor">
        <DocEditor rootID={root} ancestors={[...props.ancestors, session.rootID]} shared={shared} />
      </div>
    ),
  };
  const editable = shared.editable ?? !store.isReadOnly;

  return (
    <EnvContext.Provider value={env}>
      <BlockNoteView editor={editor} editable={editable} slashMenu={false} sideMenu={false} formattingToolbar={false}
        {...(shared.theme ? { theme: shared.theme } : {})} data-root={session.rootID}>
        <SuggestionMenuController triggerCharacter="/" getItems={async (q) => filterSuggestionItems(slashItems(editor, store), q)} />
        <SuggestionMenuController triggerCharacter="@" getItems={async (q) => mentionItems(editor, store, shared.people ?? [], q)} />
        <SideMenuController sideMenu={(p) => <SideMenu {...p} dragHandleMenu={() => <BlockMenu session={session} />} />} />
        <FormattingToolbarController formattingToolbar={() => (
          <FormattingToolbar>
            {getFormattingToolbarItems().filter((item) => !String(item.key).startsWith("textAlign"))}
          </FormattingToolbar>
        )} />
      </BlockNoteView>
    </EnvContext.Provider>
  );
}

// MARK: Slash-Menü

function slashItems(editor: BasedEditor, store: WorkspaceStore): DefaultReactSuggestionItem[] {
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
    { title: "Table of contents", subtext: "Show an outline of this page.", aliases: ["toc", "outline"], group: "Advanced blocks", onItemClick: () => insert({ type: CUSTOM.toc } as never) },
    { title: "Breadcrumb", subtext: "Show where this page sits.", aliases: ["path"], group: "Advanced blocks", onItemClick: () => insert({ type: CUSTOM.breadcrumb } as never) },
    { title: "2 columns", subtext: "Two columns side by side.", aliases: ["columns", "layout"], group: "Advanced blocks", onItemClick: () => insert(columns(2) as never) },
    { title: "3 columns", subtext: "Three columns side by side.", aliases: ["columns", "layout"], group: "Advanced blocks", onItemClick: () => insert(columns(3) as never) },
    { title: "Web bookmark", subtext: "Save a link as a visual bookmark.", aliases: ["bookmark", "url"], group: "Media", onItemClick: () => insert({ type: CUSTOM.embed, props: { kind: "bookmark" } } as never) },
    { title: "Embed", subtext: "Embed a link.", aliases: ["iframe"], group: "Media", onItemClick: () => insert({ type: CUSTOM.embed, props: { kind: "embed" } } as never) },
    { title: "PDF", subtext: "Embed a PDF.", aliases: ["pdf"], group: "Media", onItemClick: () => insert({ type: CUSTOM.embed, props: { kind: "pdf" } } as never) },
  ];
  void store;
  const defaults = getDefaultReactSlashMenuItems(editor).filter((i) => !/^(Heading [56]|Toggle Heading [56]|Emoji|Page Break)$/i.test(i.title));
  return [...defaults, ...custom];
}

/** Gleichung im Text an der Schreibmarke einfügen (leer: öffnet ihr Eingabefeld). */
export function insertInlineEquation(editor: BasedEditor, expression = "") {
  editor.insertInlineContent([{ type: INLINE.equation, props: { expression, text: "" } } as never]);
}

// MARK: @-Erwähnungen

function mentionItems(editor: BasedEditor, store: WorkspaceStore, people: readonly Person[], query: string): DefaultReactSuggestionItem[] {
  const q = query.toLowerCase();
  const insert = (kind: string, value: string, text: string) => () =>
    editor.insertInlineContent([{ type: INLINE.mention, props: { kind, value, text } } as never, " "]);
  const day = (offset: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return canonicalStringify({ start: dateToSwift(d), includeTime: false });
  };
  const pages = [...store.blocks.values()]
    .filter((b) => (b.type === "page" || b.type === "databasePage") && b.trashedAt === undefined && pageTitle(b).toLowerCase().includes(q))
    .slice(0, 6)
    .map((b): DefaultReactSuggestionItem => ({ title: pageTitle(b), subtext: "Page", group: "Pages", icon: <span>{pageIcon(b)}</span>, onItemClick: insert("page", b.id, pageTitle(b)) }));
  const persons = people.filter((p) => p.name.toLowerCase().includes(q))
    .map((p): DefaultReactSuggestionItem => ({ title: p.name, subtext: "Person", group: "People", onItemClick: insert("user", p.id, p.name) }));
  const dates: DefaultReactSuggestionItem[] = [
    { title: "Today", group: "Date", onItemClick: insert("date", day(0), "Today") },
    { title: "Tomorrow", group: "Date", onItemClick: insert("date", day(1), "Tomorrow") },
  ].filter((d) => d.title.toLowerCase().includes(q));
  return [...persons, ...dates, ...pages];
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

/** Zuletzt mit „Copy and sync“ kopiert (falls die Zwischenablage nicht erlaubt ist). */
let lastSyncClipboard: string | undefined;

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
  lastSyncClipboard = text;
  try {
    await globalThis.navigator?.clipboard?.writeText(text);
  } catch {
    /* ohne Berechtigung: lastSyncClipboard */
  }
  return original;
}

/** Einfügen von `based-sync:<id>` erzeugt eine synchronisierte Kopie hinter dem aktuellen Block. */
function pasteSynced(editor: BasedEditor, session: DocSession, event: ClipboardEvent): boolean {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  const src = syncSourceFromClipboard(text);
  if (!src) return false;
  return insertSyncedCopy(editor, session, src);
}

/** Synchronisierte Kopie eines Synced Blocks einfügen (wie Swift `pasteSyncedCopy`). */
export function insertSyncedCopy(editor: BasedEditor, session: DocSession, source: string): boolean {
  const rec = session.store.blocks.get(source);
  if (!rec || rec.type !== "syncedBlock") return false;
  const original = rec.props?.syncSource ?? rec.id;
  if (original === session.rootID) return false; // in sich selbst
  const cur = editor.getTextCursorPosition().block;
  const copy = { type: CUSTOM.syncedBlock, props: { source: original } } as never;
  const empty = cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0 && cur.children.length === 0;
  if (empty) editor.replaceBlocks([cur], [copy]);
  else editor.insertBlocks([copy], cur, "after");
  return true;
}

/** Für Tests und die Shell: was „Copy and sync“ zuletzt kopiert hat. */
export function lastCopiedSync(): string | undefined {
  return lastSyncClipboard;
}
