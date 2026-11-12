// BSD-154: Der Seiten-Editor. BlockNote-Kern auf einem Y.Doc je Seite (bzw. je Synced-Block-Original), Records
// im Store als materialisierte Ansicht. Undo/Redo lokal über den Yjs-UndoManager.
import { ImageViewer, imageAt, type ImageView } from "./ImageViewer.js";
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
  useBlockNoteEditor, useComponentsContext, useExtensionState, usePortalElement, type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { createDatabase, createLinkedView, createMeeting, duplicatePages, plainText, keysBetween, syncedOriginal, syncedPasteProblem, type SyncedPasteProblem, type WorkspaceStore } from "@based/core";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CUSTOM, INLINE, SYNC_CLIPBOARD_PREFIX, syncSourceFromClipboard } from "../mapping/bn.js";
import { freshButtons } from "./ButtonBlock.js";
import { attachBlockDrop, type BlockDropHost, type Rect } from "./dragDrop.js";
import { hasText, MARQUEE_MIN, marqueeRange, rectFrom, siblingSpan } from "./blockSelect.js";
import { basedSchema, sharedConverter, type BasedEditor } from "../schema/schema.js";
import { syntaxHighlighting } from "../schema/code.js";
import {
  applyURLChoice, blocksAsMarkdown, canTurnInto, duplicateBlocks, isCurrent, moveBlocksToPage, rangeIDs, stepRange, targetBlocks, toggleAll, TURN_INTO, TURN_INTO_EQUATION, TURN_INTO_PAGE, turnInto, turnIntoEquation,
  turnIntoPage, type ActionEditor, type BlockLike, type BlockRange, type SelectionEditor, type URLChoice,
} from "./blockActions.js";
import { DatabasePicker, MovePicker, type DatabaseRef, type DatabaseSource } from "./MovePicker.js";
import { AIBox, type AIRequest, type EditorAI } from "./AIBox.js";
import { acquireSession, releaseSession, type DocSession, type YDocStore } from "../yjs/session.js";
import type { CollabHandle, CollabSource } from "../yjs/collab.js";
import { EnvContext, storePageDirectory, type DatabaseRenderProps, type PageRef, type EditorEnv, type EquationRenderProps, type PageDirectory, type Person } from "./env.js";
import type { MeetingHost } from "./meetingHost.js";
import { mentionItems, resolveWikilink, wikilinkBefore } from "./mentions.js";
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
  /** BSD-101: Link auf einen Block (für „Copy link to block“). Ohne: kein Menüpunkt. */
  blockLink?: ((blockID: string) => string) | undefined;
  /** BSD-101: zu diesem Block springen und ihn kurz hervorheben (Link auf einen Block geöffnet). */
  focusBlock?: string | undefined;
  /** Schwebende Gliederung am rechten Rand (Standard: an; pro Seite über `props.format.hideOutline` abschaltbar). */
  outline?: boolean;
  /** Ablage der Y-Zustände; ohne: im Speicher (pro Store). */
  docStore?: YDocStore;
  /** BSD-220: Echtzeit-Text über `/collab` (Seiten-Wurzeln); ohne: nur Records + Sync. */
  collab?: CollabSource;
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
}

interface Shared extends Omit<PageEditorProps, "pageID" | "className" | "pages"> {
  docStore: YDocStore;
  pages: PageDirectory;
  pageID: string;
  notify: (message: string) => void;
  /** BSD-207: „Move to“ für Blöcke eines (ggf. eingebetteten) Editors öffnen. */
  startMove: (req: MoveRequest) => void;
  /** BSD-212: Auswahl „Linked view of database“ für einen (ggf. eingebetteten) Editor öffnen. */
  startLink: (req: LinkRequest) => void;
  /** BSD-225: AI-Feld öffnen. */
  startAI: (req: AIRequest) => void;
}

/** BSD-225: AI-Feld für die Schreibmarke bzw. die Auswahl in `editor` (an dem Block, unter ihm am Bildschirm). */
function aiRequest(editor: BasedEditor, withSelection: boolean): AIRequest | undefined {
  const view = editor.prosemirrorView;
  if (!view) return undefined;
  const blockID = editor.getTextCursorPosition().block.id;
  const sel = view.state.selection;
  const selection = withSelection && !sel.empty ? { text: view.state.doc.textBetween(sel.from, sel.to, "\n"), from: sel.from, to: sel.to } : undefined;
  const el = globalThis.document?.querySelector(`[data-id="${CSS.escape(blockID)}"]`);
  const r = el?.getBoundingClientRect();
  const coords = view.coordsAtPos(sel.to);
  return { editor, blockID, selection, page: view.state.doc.textBetween(0, view.state.doc.content.size, "\n").slice(0, 6000), x: r?.left ?? coords.left, y: (r?.bottom ?? coords.bottom) + 4 };
}

/** Offene Auswahl „Linked view of database“: in welchen Editor. */
interface LinkRequest { editor: BasedEditor; session: DocSession }

const databaseSources = new WeakMap<WorkspaceStore, DatabaseSource>();
function defaultDatabases(store: WorkspaceStore): DatabaseSource {
  let d = databaseSources.get(store);
  if (!d) {
    d = {
      list: (q) => Promise.resolve([...store.databases.values()]
        .map((db) => ({ id: db.id, title: plainText(db.title) || "Untitled" }))
        .filter((db) => db.title.toLowerCase().includes(q.trim().toLowerCase()))
        .sort((a, b) => a.title.localeCompare(b.title))),
    };
    databaseSources.set(store, d);
  }
  return d;
}

/** Offenes „Move to“: welche Blöcke aus welchem Editor. */
interface MoveRequest { editor: ActionEditor; session: DocSession; ids: string[] }

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
  // BSD-101: Link auf einen Block geöffnet – sobald er gezeichnet ist, hinscrollen und kurz hervorheben
  const focusBlock = props.focusBlock;
  // ProseMirror setzt fremde Attribute an seinen Knoten zurück: die Hervorhebung kommt als Stilregel am Rahmen
  const [flashID, setFlashID] = useState<string | undefined>();
  useEffect(() => {
    if (!focusBlock || !container) return;
    let tries = 0;
    let flash: ReturnType<typeof setTimeout> | undefined;
    const t = setInterval(() => {
      const el = container.querySelector<HTMLElement>(`.bn-block-outer[data-id="${CSS.escape(focusBlock)}"]`);
      if (!el && ++tries < 60) return;
      clearInterval(t);
      if (!el) return;
      el.scrollIntoView({ block: "center" });
      setFlashID(focusBlock);
      flash = setTimeout(() => setFlashID(undefined), 1600);
    }, 50);
    return () => { clearInterval(t); if (flash) clearTimeout(flash); };
  }, [focusBlock, container]);
  const [move, setMove] = useState<MoveRequest | undefined>();
  const [link, setLink] = useState<LinkRequest | undefined>();
  const [aiReq, setAIReq] = useState<AIRequest | undefined>();
  const [viewing, setViewing] = useState<ImageView | undefined>();
  const shared: Shared = {
    ...rest, pageID, notify, startMove: setMove, startLink: setLink, startAI: setAIReq,
    docStore: props.docStore ?? defaultDocStore(props.store),
    pages: props.pages ?? defaultDirectory(props.store),
  };
  const pickTarget = async (req: MoveRequest, page: PageRef) => {
    setMove(undefined);
    let last: string | undefined;
    try {
      last = await shared.pages.lastChildKey?.(page.id);
    } catch { /* ohne: was der Store kennt */ }
    const n = moveBlocksToPage(req.editor, req.session, req.ids, page.id, last);
    notify(n ? `Moved to ${page.title || "Untitled"}` : "Those blocks can’t be moved there.");
  };
  const databases = props.databases ?? defaultDatabases(props.store);
  const pickDatabase = async (req: LinkRequest, db: DatabaseRef) => {
    setLink(undefined);
    let ok = req.session.store.databases.has(db.id);
    if (!ok && databases.include) {
      try {
        ok = await databases.include(db.id);
      } catch { /* unten gemeldet */ }
    }
    if (!ok || !insertLinkedView(req.editor, req.session, db.id)) notify("Couldn’t link that database.");
  };
  return (
    <div className={"bx-editor " + (className ?? "")} data-page={pageID} data-flash-block={flashID} ref={setContainer} onKeyDown={(e) => {
      // ⌘⌥T / Ctrl+Alt+T: alle Toggles der Seite auf- bzw. zuklappen (wie Notion).
      if ((e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        if (container) toggleAll(container);
      }
    }} onDoubleClick={(e) => {
      const v = imageAt(e.target);
      if (v) {
        e.preventDefault();
        setViewing(v);
      }
    }}>
      {flashID ? <style>{`.bx-editor [data-id="${CSS.escape(flashID)}"] > .bn-block { background: var(--selected); border-radius: var(--radius-xs); }`}</style> : null}
      <DocEditor rootID={pageID} ancestors={[]} shared={shared} />
      {aiReq && props.ai ? <AIBox ai={props.ai} req={aiReq} onClose={() => { setAIReq(undefined); aiReq.editor.focus(); }} /> : null}
      {link ? <DatabasePicker source={databases} onClose={() => setLink(undefined)} onPick={(d) => void pickDatabase(link, d)} /> : null}
      {move ? <MovePicker pages={shared.pages} selfID={move.session.rootID} moving={move.ids} onClose={() => setMove(undefined)} onPick={(p) => void pickTarget(move, p)} /> : null}
      {viewing ? <ImageViewer view={viewing} onClose={() => setViewing(undefined)} /> : null}
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
  const { store, docStore, collab } = props.shared;
  const [session, setSession] = useState<DocSession>();
  useEffect(() => {
    let s: DocSession | undefined;
    let handle: CollabHandle | undefined;
    let cancelled = false;
    const open = () => {
      if (cancelled) {
        handle?.release();
        return;
      }
      const opts = handle
        // Echtzeit-Text: der Binder hat den gespeicherten Stand schon geprüft und angewandt; hier nur speichern.
        ? { converter: sharedConverter(), doc: handle.doc, collab: true, docStore: { load: () => undefined, save: (id: string, st: Uint8Array) => docStore.save(id, st) } }
        : { converter: sharedConverter(), docStore };
      s = acquireSession(store, props.rootID, opts);
      // Lief schon eine Sitzung (anderer Editor auf derselben Wurzel), bleibt es bei deren Modus.
      if (handle && s.doc !== handle.doc) {
        handle.release();
        handle = undefined;
      }
      setSession(s);
    };
    // BSD-220: erst /collab (falls an), sonst den gespeicherten Y-Zustand holen (Store-Worker); dann öffnen.
    const start = async () => {
      if (collab) handle = await collab.open(props.rootID).catch(() => undefined);
      if (!handle && docStore.prepare) await docStore.prepare(props.rootID).catch(() => undefined);
    };
    if (collab || docStore.prepare) void start().then(open);
    else open();
    return () => {
      cancelled = true;
      if (s) releaseSession(s);
      handle?.release();
    };
  }, [store, props.rootID, docStore, collab]);
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
  // BSD-211: nach dem Einfügen einer nackten URL – Link (Standard), Bookmark oder Embed.
  const [urlMenu, setURLMenu] = useState<{ blockID: string; url: string; x: number; y: number; active: number } | undefined>();
  const onURLRef = useRef<(blockID: string, url: string) => void>(() => {});
  onURLRef.current = (blockID, url) => {
    const rect = globalThis.getSelection?.()?.rangeCount ? globalThis.getSelection()!.getRangeAt(0).getBoundingClientRect() : undefined;
    setURLMenu({ blockID, url, x: rect?.left ?? 0, y: rect?.bottom ?? 0, active: 0 });
  };
  const sharedRef = useRef(shared);
  sharedRef.current = shared;
  const ancestorsRef = useRef(props.ancestors);
  ancestorsRef.current = props.ancestors;
  const editor = useMemo((): BasedEditor => {
    const options = withCollaboration({
      schema: basedSchema(),
      extensions: [syntaxHighlighting],
      collaboration: { fragment: session.fragment, user: { name: store.userID ?? "me", color: "var(--muted)" } },
      ...(shared.resolveFileUrl ? { resolveFileUrl: shared.resolveFileUrl } : {}),
      ...(shared.uploadFile ? { uploadFile: shared.uploadFile } : {}),
      pasteHandler: ({ event, defaultPasteHandler }: { event: ClipboardEvent; defaultPasteHandler: (c?: { prioritizeMarkdownOverHTML?: boolean; plainTextAsMarkdown?: boolean }) => boolean | undefined }): boolean => {
        const ed = editorRef.current;
        if (!ed) return defaultPasteHandler() ?? false;
        const plainOnly = Date.now() - plainPasteAt.current < PLAIN_PASTE_WINDOW_MS;
        plainPasteAt.current = 0;
        if (!plainOnly && pasteSynced(ed, session, event, ancestorsRef.current, sharedRef.current)) return true;
        return handlePaste(ed, { event, defaultPasteHandler, plainOnly, onURL: (blockID, url) => onURLRef.current(blockID, url),
          pageExists: (id) => { const p = sharedRef.current.pages.get(id); return p !== undefined && !p.missing; } });
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
    databases: shared.databases ?? defaultDatabases(store),
    flush: () => session.flush(),
    renderSynced: (root, opts) => (
      <div className="bx-synced-editor">
        <DocEditor rootID={root} ancestors={[...props.ancestors, session.rootID]} shared={shared} readOnly={props.readOnly || opts?.readOnly === true} />
      </div>
    ),
  };
  const mentionOptions = { pages: shared.pages, people: shared.people ?? [], selfID: shared.pageID };
  const actions = editor as unknown as ActionEditor;

  /** ⌘D, Blockmenü, Blockauswahl: Textblöcke im Editor, Unterseiten/Datenbanken tief im Store. */
  const duplicate = (blocks: readonly BlockLike[]) => {
    const r = duplicateBlocks(actions, blocks);
    if (r.records.length) {
      session.flush();
      const copy = shared.duplicatePages ? shared.duplicatePages(r.records) : Promise.resolve(duplicatePages(store, r.records));
      copy.catch((e: unknown) => shared.notify("Couldn’t duplicate: " + (e instanceof Error ? e.message : String(e))));
    }
    if (r.skipped) shared.notify("Synced blocks and meetings can’t be duplicated.");
    return r;
  };

  // Blockauswahl (Esc, wie Notion): markierte Blöcke, ↑/↓ wandern, ⇧↑/⇧↓ erweitern, Enter schreibt weiter,
  // ⌫/Entf löschen, ⌘D dupliziert, ⌘⇧P „Move to“, Esc hebt auf. Der Fokus liegt solange auf dem Rahmen.
  const [range, setRange] = useState<BlockRange | undefined>();
  const docRef = useRef<HTMLDivElement>(null);
  // BSD-249: Ziehen zum Verschachteln/Ausrücken und für Spalten (dragDrop.ts); der Strich zeigt, wohin es fällt.
  const [dropRect, setDropRect] = useState<Rect | undefined>();
  // Der Block, dessen Griff ⋮⋮ gerade gezeigt wird (BlockNotes Auswahl beim Fassen ist nicht immer dieser Block).
  const sideBlock = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block?.id });
  const sideBlockRef = useRef<string | undefined>(undefined);
  sideBlockRef.current = sideBlock;
  // Der Rahmen kann später erscheinen als der Editor (Laden des Y-Zustands): am Element festmachen, nicht am ersten Render.
  const [docEl, setDocEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!editable || !docEl) return;
    return attachBlockDrop(editor as unknown as BlockDropHost, docEl, setDropRect, () => sideBlockRef.current, () => selectedRef.current);
  }, [editor, editable, docEl]);
  const sel = editor as unknown as SelectionEditor;
  const selected = range ? rangeIDs(sel, range) : [];
  const selectedRef = useRef<readonly string[]>([]);
  selectedRef.current = selected;
  const selectBlocks = (r: BlockRange | undefined) => {
    setRange(r);
    if (!r) return;
    const ids = rangeIDs(sel, r);
    try {
      // Auch als Editor-Auswahl, damit Blockmenü-Aktionen (Turn into, Colors …) auf alle wirken.
      if (ids.length) editor.setSelection(ids[0]!, ids[ids.length - 1]!);
    } catch { /* Blöcke ohne Text: nur die Markierung */ }
    docRef.current?.focus({ preventScroll: true });
    globalThis.document?.querySelector(`[data-id="${CSS.escape(r.head)}"]`)?.scrollIntoView?.({ block: "nearest" });
  };
  const leaveSelection = (to?: string) => {
    setRange(undefined);
    if (to && editor.getBlock(to)) {
      try {
        editor.setTextCursorPosition(to, "end");
      } catch { /* Block ohne Text */ }
    }
    editor.focus();
  };
  // BSD-258: Rechteck aus dem Rand, Textauswahl über Nicht-Text-Blöcke, ⇧-Klick, ⌘A zweimal.
  const [marquee, setMarquee] = useState<Rect | undefined>();
  const parentOf = (id: string) => editor.getParentBlock(id) as { id: string } | undefined;
  const blockAt = (el: EventTarget | null): string | undefined => {
    const outer = (el as Element | null)?.closest?.(".bn-block-outer[data-id]");
    return outer && outer.closest(".bn-editor") === editor.domElement ? outer.getAttribute("data-id") ?? undefined : undefined;
  };
  const startMarquee = (e: { clientX: number; clientY: number }) => {
    const root = editor.domElement;
    if (!root) return;
    const from = { x: e.clientX, y: e.clientY };
    let started = false;
    const top = () => [...root.querySelectorAll(":scope > .bn-block-group > .bn-block-outer[data-id]")].map((o) => {
      const r = o.getBoundingClientRect();
      return { id: o.getAttribute("data-id")!, top: r.top, bottom: r.bottom };
    });
    const move = (ev: MouseEvent) => {
      const r = rectFrom(from, { x: ev.clientX, y: ev.clientY });
      if (!started && r.right - r.left < MARQUEE_MIN && r.bottom - r.top < MARQUEE_MIN) return;
      started = true;
      ev.preventDefault();
      setMarquee(r);
      const hit = marqueeRange(r, top());
      if (hit) selectBlocks(hit);
      else setRange(undefined);
    };
    const up = () => {
      globalThis.removeEventListener("mousemove", move);
      globalThis.removeEventListener("mouseup", up);
      setMarquee(undefined);
    };
    globalThis.addEventListener("mousemove", move);
    globalThis.addEventListener("mouseup", up);
  };
  /**
   * Ziehen aus dem Text: sobald die Spanne einen Block ohne Text (Bild, Trenner, Datenbank …) berührt, wird daraus eine
   * Blockauswahl (wie Notion). Browser (vor allem WebKit) verlieren die Textauswahl sonst an solchen Blöcken.
   */
  const trackPress = (startID: string) => {
    let blockMode = false;
    const move = (ev: MouseEvent) => {
      if ((ev.buttons & 1) === 0) return up();
      // Schwebendes (die Formatleiste der vorigen Auswahl blendet noch aus, Tooltips) liegt über dem Text: der erste
      // Treffer, der zu einem Block gehört, zählt – sonst endet die Auswahl unter der Leiste einen Block zu früh.
      let cur: string | undefined;
      for (const el of globalThis.document?.elementsFromPoint?.(ev.clientX, ev.clientY) ?? []) {
        cur = blockAt(el);
        if (cur) break;
      }
      if (!cur || (cur === startID && !blockMode)) return;
      const span = siblingSpan(parentOf, startID, cur);
      const ids = rangeIDs(sel, span);
      if (!blockMode && ids.every((id) => hasText(editor.getBlock(id) ?? {}))) return;
      blockMode = true;
      globalThis.getSelection?.()?.removeAllRanges();
      selectBlocks(span);
    };
    const up = () => {
      globalThis.removeEventListener("mousemove", move);
      globalThis.removeEventListener("mouseup", up);
    };
    globalThis.addEventListener("mousemove", move);
    globalThis.addEventListener("mouseup", up);
  };
  /** Nach einer Mausauswahl über mehrere Blöcke: liegt ein Block ohne Text darin, wird es eine Blockauswahl. */
  const textToBlocks = () => {
    const view = editor.prosemirrorView;
    if (!view || view.state.selection.empty) return;
    const blocks = editor.getSelection()?.blocks ?? [];
    if (blocks.length < 2 || blocks.every((b) => hasText(b))) return;
    selectBlocks(siblingSpan(parentOf, blocks[0]!.id, blocks[blocks.length - 1]!.id));
  };
  const lastSelectAll = useRef(0);
  // BSD-289: „zweimal“ heißt direkt hintereinander – jeder Klick dazwischen (Formatleiste, AI-Box …) setzt es zurück.
  useEffect(() => {
    const reset = () => { lastSelectAll.current = 0; };
    globalThis.document?.addEventListener("pointerdown", reset, true);
    return () => globalThis.document?.removeEventListener("pointerdown", reset, true);
  }, []);
  // Loslassen kann auch außerhalb des Rahmens passieren: am Dokument lauschen.
  const textToBlocksRef = useRef(textToBlocks);
  textToBlocksRef.current = textToBlocks;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  useEffect(() => {
    const up = (e: MouseEvent) => {
      if (e.button !== 0 || rangeRef.current || !editor.domElement?.contains(globalThis.document?.getSelection()?.anchorNode ?? null)) return;
      // WebKit meldet die Auswahl an ProseMirror erst nach dem Loslassen (selectionchange): kurz warten.
      setTimeout(() => textToBlocksRef.current(), 60);
    };
    globalThis.document?.addEventListener("mouseup", up);
    return () => globalThis.document?.removeEventListener("mouseup", up);
  }, [editor]);
  const chooseURL = (choice: URLChoice) => {
    if (urlMenu) applyURLChoice(actions, urlMenu.blockID, urlMenu.url, choice);
    setURLMenu(undefined);
    editor.focus();
  };
  const onSelectionKey = (e: KeyboardEvent) => {
    if (!range) return;
    const mod = e.metaKey || e.ctrlKey;
    const blocks = selected.map((id) => actions.getBlock(id)).filter((b): b is BlockLike => b !== undefined);
    if (e.key === "Escape") leaveSelection(range.head); // Schreibmarke ans Ende statt Textauswahl (sonst bleibt die Formatleiste)
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") selectBlocks(stepRange(sel, range, e.key === "ArrowUp" ? -1 : 1, e.shiftKey));
    else if (e.key === "Enter") leaveSelection(range.head);
    else if (mod && e.key.toLowerCase() === "a") {
      const all = editor.document;
      if (all.length) selectBlocks({ anchor: all[0]!.id, head: all[all.length - 1]!.id });
    }
    else if (editable && (e.key === "Backspace" || e.key === "Delete")) {
      const before = editor.getPrevBlock(selected[0]!)?.id;
      editor.removeBlocks(selected);
      leaveSelection(before);
    } else if (editable && mod && !e.shiftKey && e.key.toLowerCase() === "d") {
      const r = duplicate(blocks);
      if (r.inserted.length) selectBlocks({ anchor: r.inserted[0]!, head: r.inserted[r.inserted.length - 1]! });
    } else if (editable && mod && e.shiftKey && e.key.toLowerCase() === "p") {
      shared.startMove({ editor: actions, session, ids: selected });
      setRange(undefined);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <EnvContext.Provider value={env}>
      <div className="bx-doc" ref={(el) => { docRef.current = el; setDocEl(el); }} tabIndex={-1} data-collab={session.collab ? "" : undefined} data-block-selection={range ? selected.join(" ") : undefined} onKeyDownCapture={(e) => {
        if (range && e.target === e.currentTarget) {
          onSelectionKey(e);
          return;
        }
        if (e.target !== editor.domElement) return; // eingebettete Editoren (Synced Block) haben ihren eigenen Rahmen
        // BSD-90 Teil 2: „[[Titel]]“ fertig getippt → Seiten-Erwähnung (vorhandene Seite oder neu angelegt)
        if (e.key === "]" && !e.metaKey && !e.ctrlKey && !e.altKey && editable) {
          const view = editor.prosemirrorView;
          const sel = view?.state.selection;
          if (view && sel?.empty) {
            const before = sel.$from.parent.textBetween(0, sel.$from.parentOffset, undefined, "\ufffc");
            const title = wikilinkBefore(before);
            if (title) {
              e.preventDefault();
              const len = before.length - before.lastIndexOf("[[");
              view.dispatch(view.state.tr.delete(sel.from - len, sel.from));
              void resolveWikilink(editor, title, mentionOptions, sel.from - len);
              return;
            }
          }
        }
        if (urlMenu) {
          // Menü nach URL-Einfügen: Pfeile/Enter wählen, Esc und jede andere Taste schließen (getippt wird weiter).
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const n = URL_CHOICES.length;
            setURLMenu({ ...urlMenu, active: (urlMenu.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            chooseURL(URL_CHOICES[urlMenu.active]!.choice);
            return;
          }
          if (!["Shift", "Meta", "Control", "Alt"].includes(e.key)) setURLMenu(undefined);
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        }
        if (e.shiftKey && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") plainPasteAt.current = Date.now();
        // ⌘D: Block (bzw. ausgewählte Blöcke) duplizieren, wie in Notion.
        if (editable && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") {
          e.preventDefault();
          duplicate(targetBlocks(actions, caretBlockID(editor)));
        }
        // BSD-225: Leertaste auf leerer Zeile öffnet „Ask AI“ (wie Notion), wenn die Shell eine AI anbietet.
        if (shared.ai && shared.ai.available?.() !== false && editable && e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.nativeEvent.isComposing) {
          const cur = editor.getTextCursorPosition().block;
          if (cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0) {
            const req = aiRequest(editor, false);
            if (req) {
              e.preventDefault();
              shared.startAI(req);
              return;
            }
          }
        }
        // ⌘A zweimal (kurz hintereinander, ohne andere Taste dazwischen): alle Blöcke als Blockauswahl.
        const isSelectAll = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a";
        if (!isSelectAll && !["Meta", "Control", "Shift", "Alt"].includes(e.key)) lastSelectAll.current = 0;
        if (isSelectAll) {
          const now = Date.now();
          if (now - lastSelectAll.current < 1500) {
            const all = editor.document;
            if (all.length) {
              e.preventDefault();
              e.stopPropagation();
              lastSelectAll.current = 0;
              selectBlocks({ anchor: all[0]!.id, head: all[all.length - 1]!.id });
              return;
            }
          }
          lastSelectAll.current = now;
        }
        // Esc: Blockauswahl (nicht, solange ein Menü offen ist – das schließt Esc selbst).
        if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing && !globalThis.document?.querySelector(".bn-suggestion-menu")) {
          const ids = targetBlocks(actions, caretBlockID(editor)).map((b) => b.id);
          const first = ids[0], last = ids[ids.length - 1];
          if (first && last) {
            e.preventDefault();
            e.stopPropagation();
            selectBlocks({ anchor: first, head: last });
          }
        }
      }} onMouseDownCapture={(e) => {
        if (e.button !== 0) return;
        const id = blockAt(e.target);
        // ⇧-Klick erweitert eine Blockauswahl bis zum geklickten Block.
        if (range && e.shiftKey && id) {
          e.preventDefault();
          e.stopPropagation();
          selectBlocks(siblingSpan(parentOf, range.anchor, id));
          return;
        }
        if (range) setRange(undefined);
        if (id && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) trackPress(id);
        // Im leeren Rand neben dem Text (links/rechts der Blöcke, nicht auf Griff oder Menü): Rechteck-Auswahl.
        const root = editor.domElement;
        const t = e.target as Element;
        if (editable && root && (t === root || t === docRef.current) && !id) {
          const first = root.querySelector(".bn-block-content")?.getBoundingClientRect();
          if (first && (e.clientX < first.left || e.clientX > first.right)) {
            e.preventDefault();
            startMarquee(e);
          }
        }
      }} onCopy={(e) => {
        if (!range || e.target !== e.currentTarget) return;
        e.preventDefault();
        e.clipboardData.setData("text/plain", blocksAsMarkdown(session, selected));
      }} onCut={(e) => {
        if (!range || e.target !== e.currentTarget) return;
        e.preventDefault();
        e.clipboardData.setData("text/plain", blocksAsMarkdown(session, selected));
        if (editable) {
          const before = editor.getPrevBlock(selected[0]!)?.id;
          editor.removeBlocks(selected);
          leaveSelection(before);
        }
      }}>
        {marquee ? <div className="bx-marquee" aria-hidden="true" style={{ left: marquee.left, top: marquee.top, width: marquee.right - marquee.left, height: marquee.bottom - marquee.top }} /> : null}
        {urlMenu ? (
          <div className="bx-url-menu" role="menu" aria-label="Paste as" style={{ left: urlMenu.x, top: urlMenu.y }} onMouseDown={(e) => e.preventDefault()}>
            {URL_CHOICES.map((c, i) => (
              <button key={c.choice} type="button" role="menuitem" className="bx-url-item" data-active={i === urlMenu.active} onClick={() => chooseURL(c.choice)}>
                <span>{c.label}</span><span className="bx-muted">{c.hint}</span>
              </button>
            ))}
          </div>
        ) : null}
        {dropRect ? <div className="bx-drop-indicator" aria-hidden="true" style={{ left: dropRect.left, top: dropRect.top, width: dropRect.right - dropRect.left, height: dropRect.bottom - dropRect.top }} /> : null}
        {selected.length ? <style>{selected.map((id) => `.bx-doc [data-id="${CSS.escape(id)}"] > .bn-block`).join(",\n") + " { background: var(--selected); border-radius: var(--radius-xs); }"}</style> : null}
        <BlockNoteView editor={editor} editable={editable} slashMenu={false} sideMenu={false} formattingToolbar={false}
          {...(shared.theme ? { theme: shared.theme } : {})} data-root={session.rootID}>
          <SuggestionMenuController triggerCharacter="/" getItems={async (q) => filterSuggestionItems(slashItems(editor, session, props.ancestors, shared), q)} />
          <SuggestionMenuController triggerCharacter="@" getItems={(q) => mentionItems(editor, q, mentionOptions)} />
          <SuggestionMenuController triggerCharacter="[[" getItems={(q) => mentionItems(editor, q, { ...mentionOptions, pagesOnly: true })} />
          <SideMenuController sideMenu={(p) => <SideMenu {...p} dragHandleMenu={() => <BlockMenu session={session} duplicate={duplicate} startMove={shared.startMove} blockLink={shared.blockLink} notify={shared.notify} />} />} />
          <FormattingToolbarController formattingToolbar={() => (
            <FormattingToolbar>
              {shared.ai && editable ? <AskAIButton key="askAI" onAsk={() => { const r = aiRequest(editor, true); if (r) shared.startAI(r); }} /> : null}
              {getFormattingToolbarItems().filter((item) => !String(item.key).startsWith("textAlign"))}
            </FormattingToolbar>
          )} />
        </BlockNoteView>
      </div>
    </EnvContext.Provider>
  );
}

/**
 * Block an der Schreibmarke. Erst aus der DOM-Auswahl: direkt nach einem Klick hat ProseMirror die neue Auswahl
 * (selectionchange) evtl. noch nicht übernommen, wenn die nächste Taste kommt.
 */
function caretBlockID(editor: BasedEditor): string {
  const node = globalThis.getSelection?.()?.anchorNode;
  const el = node instanceof Element ? node : node?.parentElement;
  const id = el && editor.domElement?.contains(el) ? el.closest(".bn-block-outer")?.getAttribute("data-id") : undefined;
  return id && editor.getBlock(id) ? id : editor.getTextCursorPosition().block.id;
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
    { title: "Database – Inline", subtext: "Add a database view to this page.", aliases: ["table view", "database"], group: "Database", onItemClick: () => insertInlineDatabase(editor, session) },
    ...(shared.ai ? [{ title: "Ask AI", subtext: "Let AI write from a prompt.", aliases: ["ai", "write", "generate"], group: "AI", onItemClick: () => { const r = aiRequest(editor, false); if (r) shared.startAI(r); } }] : []),
    { title: "Linked view of database", subtext: "Show an existing database on this page.", aliases: ["linked", "linked database", "view"], group: "Database", onItemClick: () => shared.startLink({ editor, session }) },
    { title: "Block equation", subtext: "Display a standalone math equation.", aliases: ["math", "tex", "latex", "equation"], group: "Advanced blocks", onItemClick: () => insert({ type: CUSTOM.equation } as never) },
    { title: "Inline equation", subtext: "Insert a math equation in the text.", aliases: ["math", "tex", "latex", "equation", "inline"], group: "Advanced blocks", onItemClick: () => insertInlineEquation(editor) },
    { title: "Meeting notes", subtext: "Record a meeting, take timestamped notes, get a summary.", aliases: ["meet", "meeting", "transcribe", "record", "notes"], group: "Advanced blocks", onItemClick: () => insertMeeting(editor, session) },
    { title: "HTML", subtext: "HTML code with a live preview (sandboxed, offline).", aliases: ["html", "web"], group: "Advanced blocks", onItemClick: () => insert({ type: "codeBlock", props: { language: "html" } } as never) },
    { title: "Table of contents", subtext: "Show an outline of this page.", aliases: ["toc", "outline"], group: "Advanced blocks", onItemClick: () => insert({ type: CUSTOM.toc } as never) },
    { title: "Button", subtext: "Run steps with one click: insert blocks, add a page, open a link.", aliases: ["button", "action", "automation"], group: "Advanced blocks", onItemClick: () => {
      const id = globalThis.crypto.randomUUID().toUpperCase();
      freshButtons.add(id);
      insert({ id, type: CUSTOM.button } as never);
    } },
    { title: "Breadcrumb", subtext: "Show where this page sits.", aliases: ["path"], group: "Advanced blocks", onItemClick: () => insert({ type: CUSTOM.breadcrumb } as never) },
    { title: "2 columns", subtext: "Two columns side by side.", aliases: ["columns", "layout"], group: "Advanced blocks", onItemClick: () => insert(columns(2) as never) },
    { title: "3 columns", subtext: "Three columns side by side.", aliases: ["columns", "layout"], group: "Advanced blocks", onItemClick: () => insert(columns(3) as never) },
    { title: "4 columns", subtext: "Four columns side by side.", aliases: ["columns", "layout"], group: "Advanced blocks", onItemClick: () => insert(columns(4) as never) },
    { title: "5 columns", subtext: "Five columns side by side.", aliases: ["columns", "layout"], group: "Advanced blocks", onItemClick: () => insert(columns(5) as never) },
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
  // Schreibmarke in den Absatz danach (bei Bedarf angelegt): kein ausgewählter Block, man schreibt unter ihm weiter.
  let next = editor.getNextBlock(id);
  if (!next) {
    editor.insertBlocks([{ type: "paragraph" } as never], id, "after");
    next = editor.getNextBlock(id);
  }
  if (next) editor.setTextCursorPosition(next, "start");
  return id;
}

/**
 * „/Database – Inline“: Datenbank, erste Ansicht und Beispielzeilen still in den Store, dann der Block mit derselben
 * ID ins Dokument (wie insertMeeting) – vorher entstand nur ein Platzhalter ohne Datenbank.
 */
export function insertInlineDatabase(editor: BasedEditor, session: DocSession): string {
  session.flush();
  const id = globalThis.crypto.randomUUID().toUpperCase();
  const made = session.quietly(() => createDatabase(session.store, { parent: "b:" + session.rootID, inline: true, blockID: id, undoable: false }));
  const cur = editor.getTextCursorPosition().block;
  const block = { id, type: CUSTOM.database, props: { databaseID: made.databaseID, viewID: made.viewID } } as never;
  const empty = cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0 && cur.children.length === 0;
  if (empty) editor.replaceBlocks([cur], [block]);
  else editor.insertBlocks([block], cur, "after");
  let next = editor.getNextBlock(id);
  if (!next) {
    editor.insertBlocks([{ type: "paragraph" } as never], id, "after");
    next = editor.getNextBlock(id);
  }
  if (next) editor.setTextCursorPosition(next, "start");
  return id;
}

/**
 * BSD-212: „Linked view of database“ – neue Ansicht der gewählten Datenbank still in den Store (die Datenbank muss
 * dort schon sein), dann der Block mit derselben ID ins Dokument (wie insertInlineDatabase).
 */
export function insertLinkedView(editor: BasedEditor, session: DocSession, databaseID: string): string | undefined {
  session.flush();
  const id = globalThis.crypto.randomUUID().toUpperCase();
  const made = session.quietly(() => createLinkedView(session.store, databaseID, "b:" + session.rootID, "table", { blockID: id, undoable: false }));
  if (!made) return undefined;
  const cur = editor.getTextCursorPosition().block;
  const block = { id, type: CUSTOM.database, props: { databaseID, viewID: made.viewID } } as never;
  const empty = cur.type === "paragraph" && Array.isArray(cur.content) && cur.content.length === 0 && cur.children.length === 0;
  if (empty) editor.replaceBlocks([cur], [block]);
  else editor.insertBlocks([block], cur, "after");
  let next = editor.getNextBlock(id);
  if (!next) {
    editor.insertBlocks([{ type: "paragraph" } as never], id, "after");
    next = editor.getNextBlock(id);
  }
  if (next) editor.setTextCursorPosition(next, "start");
  return id;
}

/** Gleichung im Text an der Schreibmarke einfügen (leer: öffnet ihr Eingabefeld). */
export function insertInlineEquation(editor: BasedEditor, expression = "") {
  editor.insertInlineContent([{ type: INLINE.equation, props: { expression, text: "" } } as never]);
}

/** BSD-225: „Ask AI“ vorn in der Formatleiste über einer Auswahl. */
function AskAIButton({ onAsk }: { onAsk: () => void }) {
  const Components = useComponentsContext()!;
  return <Components.FormattingToolbar.Button className="bn-button bx-ask-ai" label="Ask AI" mainTooltip="Ask AI" onClick={onAsk}>Ask AI</Components.FormattingToolbar.Button>;
}

// MARK: Block-Menü mit „Copy and sync“

function BlockMenu(props: { session: DocSession; duplicate: (blocks: readonly BlockLike[]) => unknown; startMove: (req: MoveRequest) => void; blockLink?: ((id: string) => string) | undefined; notify: (m: string) => void }) {
  return (
    <DragHandleMenu>
      <TurnIntoItem session={props.session} />
      <DuplicateItem duplicate={props.duplicate} />
      <MoveToItem session={props.session} startMove={props.startMove} />
      <CopyMarkdownItem session={props.session} />
      <BlockColorsItem>Colors</BlockColorsItem>
      <CopyAndSyncItem session={props.session} />
      {props.blockLink ? <CopyLinkItem link={props.blockLink} notify={props.notify} /> : null}
      <RemoveBlockItem>Delete</RemoveBlockItem>
    </DragHandleMenu>
  );
}

/** BSD-207: „Duplicate“ (⌘D) im Blockmenü – wirkt auf die Auswahl, wenn der Block darin liegt. */
function DuplicateItem(props: { duplicate: (blocks: readonly BlockLike[]) => unknown }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as BasedEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  if (!block) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => {
      const a = editor as unknown as ActionEditor;
      props.duplicate(targetBlocks(a, block.id));
    }}>
      Duplicate <span className="bx-menu-key">⌘D</span>
    </Components.Generic.Menu.Item>
  );
}

/** BSD-211: „Copy as Markdown“ – Blöcke (bzw. Auswahl) über den Markdown-Exporter des Kerns in die Zwischenablage. */
function CopyMarkdownItem(props: { session: DocSession }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as BasedEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  if (!block) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => {
      const a = editor as unknown as ActionEditor;
      const md = blocksAsMarkdown(props.session, targetBlocks(a, block.id).map((b) => b.id));
      lastMarkdownCopy = md;
      void globalThis.navigator?.clipboard?.writeText(md).catch(() => { /* ohne Berechtigung: lastMarkdownCopy */ });
    }}>
      Copy as Markdown
    </Components.Generic.Menu.Item>
  );
}

/** Zuletzt mit „Copy as Markdown“ kopiert (für Tests und Umgebungen ohne Zwischenablage-Recht). */
export let lastMarkdownCopy = "";

const URL_CHOICES: readonly { choice: URLChoice; label: string; hint: string }[] = [
  { choice: "link", label: "Link", hint: "Keep as text link" },
  { choice: "bookmark", label: "Bookmark", hint: "Card with the address" },
  { choice: "embed", label: "Embed", hint: "Embed the page" },
];

/** BSD-207: „Move to“ – öffnet die Seitensuche; wirkt auf die Auswahl, wenn der Block darin liegt. */
function MoveToItem(props: { session: DocSession; startMove: (req: MoveRequest) => void }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as BasedEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  if (!block) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => {
      const a = editor as unknown as ActionEditor;
      props.startMove({ editor: a, session: props.session, ids: targetBlocks(a, block.id).map((b) => b.id) });
    }}>
      Move to
    </Components.Generic.Menu.Item>
  );
}

/** BSD-207: „Turn into“ als Untermenü – alle Blöcke mit Text, Callout eingeschlossen, dazu „Page“. */
function TurnIntoItem(props: { session: DocSession }) {
  const Components = useComponentsContext()!;
  const portalElement = usePortalElement();
  const editor = useBlockNoteEditor() as unknown as BasedEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  const a = editor as unknown as ActionEditor;
  const current = block ? a.getBlock(block.id) : undefined;
  if (!current || !canTurnInto(current)) return null;
  return (
    <Components.Generic.Menu.Root position="right" sub={true} portalElement={portalElement}>
      <Components.Generic.Menu.Trigger sub={true}>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger={true}>Turn into</Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub={true} className="bn-menu-dropdown">
        {TURN_INTO.map((o) => (
          <Components.Generic.Menu.Item key={o.key} className="bn-menu-item" checked={isCurrent(current, o)}
            onClick={() => turnInto(a, targetBlocks(a, current.id), o)}>
            {o.label}
          </Components.Generic.Menu.Item>
        ))}
        <Components.Generic.Menu.Item key={TURN_INTO_EQUATION.key} className="bn-menu-item" onClick={() => turnIntoEquation(a, targetBlocks(a, current.id))}>
          {TURN_INTO_EQUATION.label}
        </Components.Generic.Menu.Item>
        <Components.Generic.Menu.Item key={TURN_INTO_PAGE.key} className="bn-menu-item" onClick={() => void turnIntoPage(a, props.session, current.id)}>
          {TURN_INTO_PAGE.label}
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

/** BSD-101: „Copy link to block“ – Link auf genau diesen Block in die Zwischenablage. */
function CopyLinkItem(props: { link: (id: string) => string; notify: (m: string) => void }) {
  const Components = useComponentsContext()!;
  const editor = useBlockNoteEditor() as unknown as BasedEditor;
  const block = useExtensionState(SideMenuExtension, { editor, selector: (s) => s?.block });
  if (!block) return null;
  return (
    <Components.Generic.Menu.Item className="bn-menu-item" onClick={() => {
      const url = props.link(block.id);
      void Promise.resolve(globalThis.navigator?.clipboard?.writeText(url)).then(() => props.notify("Link to block copied"), () => props.notify("Couldn’t copy the link"));
    }}>
      Copy link to block
    </Components.Generic.Menu.Item>
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
