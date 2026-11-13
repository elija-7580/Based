// BSD-154: Eigene Blocktypen (BlockNote-Kern, MPL-2.0; keine @blocknote/xl-*, ADR 0011). Darstellung nur mit
// Klassen aus styles.css (Tokens). Inhalte, die andere Pakete zeichnen (Datenbank-Ansicht, KaTeX), kommen über
// Callbacks aus dem EditorEnv.
import { defaultProps, type BlockNoteEditor } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { canonicalStringify, containingPage, embedTarget, headingOutline, plainText, trashedRoot, unsyncCopy, type Block, type BookmarkMeta } from "@based/core";
import { bookmarkMeta } from "../mapping/blocks.js";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { CUSTOM, SYNC_CLIPBOARD_PREFIX } from "../mapping/bn.js";
import { useEnv, usePageRef, useStoreRevision } from "../ui/env.js";
import { columnFractions, resizeColumns } from "../ui/columns.js";
import { ButtonBlockView, type CaretEditor } from "../ui/ButtonBlock.js";
import { EmojiPicker } from "../ui/EmojiPicker.js";
import { IconView } from "../ui/phosphor.js";
import { scrollToHeading } from "../ui/Outline.js";
import { fetchBookmarkPreview } from "../ui/linkPreview.js";
import { rememberSyncClipboard } from "../ui/syncClipboard.js";

const colorProps = { textColor: defaultProps.textColor, backgroundColor: defaultProps.backgroundColor };
/** Standard-Icon eines Callouts ohne eigenes (wie Swift). */
const CALLOUT_ICONS = ["💡"];

// MARK: Hilfen

type AnyEditor = BlockNoteEditor<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function pageTitle(b: Block | undefined): string {
  const t = plainText(b?.text).trim();
  return t === "" ? "Untitled" : t;
}

export function pageIcon(b: Block | undefined): string {
  const icon = b?.props?.icon;
  if (typeof icon === "string" && icon !== "") return icon;
  if (icon && typeof icon === "object" && "emoji" in icon && typeof icon.emoji === "string") return icon.emoji;
  return b?.type === "databasePage" ? "▦" : "📄";
}

function Atom(props: { kind: string; children: ReactNode; className?: string }) {
  return (
    <div className={"bx-atom " + (props.className ?? "")} data-bx={props.kind} contentEditable={false}>
      {props.children}
    </div>
  );
}

/** Kleines Eingabefeld in einem Block (Tasten gehen nicht an den Editor). */
function InlineField(props: { value: string; placeholder: string; multiline?: boolean; onDone: (v: string) => void; onCancel?: () => void; onInput?: (v: string) => void }) {
  const [v, setV] = useState(props.value);
  const key = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") props.onCancel?.();
    if (e.key === "Enter" && (!props.multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      props.onDone(v);
    }
  };
  const common = {
    className: "bx-field",
    value: v,
    placeholder: props.placeholder,
    autoFocus: true,
    onChange: (e: { target: { value: string } }) => {
      setV(e.target.value);
      props.onInput?.(e.target.value);
    },
    onKeyDown: key,
    onBlur: () => props.onDone(v),
  };
  return props.multiline ? <textarea rows={2} {...common} /> : <input {...common} />;
}

// MARK: Callout

/** Callout-Icon: Klick öffnet den Emoji-Picker (vorher: sechs feste Symbole durchklicken). */
function CalloutIcon(props: { editor: AnyEditor; id: string; icon: string }) {
  const env = useEnv();
  const [open, setOpen] = useState(false);
  const shown = props.icon || CALLOUT_ICONS[0]!;
  return (
    <span className="bx-callout-icon-wrap" contentEditable={false}>
      <button type="button" className="bx-callout-icon" aria-label="Icon" aria-haspopup="dialog" aria-expanded={open} disabled={!env.editable}
        onClick={() => setOpen((o) => !o)}><IconView icon={shown} fallback={CALLOUT_ICONS[0]} /></button>
      {open ? (
        <EmojiPicker className="bx-callout-picker" current={props.icon || undefined} onClose={() => setOpen(false)}
          onPick={(emoji) => {
            props.editor.updateBlock(props.id, { props: { icon: emoji ?? "" } });
            setOpen(false);
          }} />
      ) : null}
    </span>
  );
}

export const calloutBlock = createReactBlockSpec(
  { type: CUSTOM.callout, propSchema: { ...colorProps, icon: { default: "" } }, content: "inline" },
  {
    render: ({ block, editor, contentRef }) => (
      <div className="bx-callout" data-color={block.props.backgroundColor}>
        <CalloutIcon editor={editor as AnyEditor} id={block.id} icon={block.props.icon} />
        <div className="bx-callout-text" ref={contentRef} />
      </div>
    ),
  },
);

// MARK: Gleichung

function EquationView(props: { expression: string; editor: AnyEditor; block: { id: string } }) {
  const env = useEnv();
  const [editing, setEditing] = useState(props.expression === "");
  const [draft, setDraft] = useState(props.expression);
  if (editing && props.editor.isEditable) {
    // Eingabefeld mit Live-Vorschau (KaTeX über env.renderEquation; Fehler zeigt der Renderer an).
    return (
      <Atom kind="equation" className="bx-equation is-editing">
        <InlineField value={props.expression} placeholder="E = mc^2" multiline onInput={setDraft}
          onDone={(v) => {
            setEditing(false);
            if (v !== props.expression) props.editor.updateBlock(props.block.id, { props: { expression: v } });
          }}
          onCancel={() => setEditing(false)} />
        {draft.trim() !== "" && env.renderEquation
          ? <div className="bx-equation-preview" aria-label="Preview">{env.renderEquation({ expression: draft, displayMode: true })}</div>
          : null}
      </Atom>
    );
  }
  return (
    <Atom kind="equation" className="bx-equation">
      <div className="bx-equation-view" role="button" tabIndex={0} aria-label="Edit equation" onClick={() => {
        setDraft(props.expression);
        setEditing(true);
      }} onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          setDraft(props.expression);
          setEditing(true);
        }
      }}>
        {props.expression === ""
          ? <span className="bx-muted">Add a TeX equation</span>
          : env.renderEquation?.({ expression: props.expression, displayMode: true }) ?? <code className="bx-tex">{props.expression}</code>}
      </div>
    </Atom>
  );
}

export const equationBlock = createReactBlockSpec(
  { type: CUSTOM.equation, propSchema: { expression: { default: "" } }, content: "none" },
  { render: ({ block, editor }) => <EquationView expression={block.props.expression} editor={editor} block={block} /> },
);

// MARK: Unterseite

function PageLink(props: { id: string; missing?: string }) {
  const env = useEnv();
  useStoreRevision(env.store);
  const rec = env.store.blocks.get(props.id);
  if (!rec) return <span className="bx-muted">{props.missing ?? "Page not found"}</span>;
  const open = () => {
    env.flush();
    env.onOpenPage?.(props.id);
  };
  return (
    <span className="bx-pagelink" role="link" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
      <span className="bx-pagelink-icon" aria-hidden><IconView icon={pageIcon(rec)} fallback="📄" /></span>
      <span className="bx-pagelink-title">{pageTitle(rec)}</span>
    </span>
  );
}

export const pageBlock = createReactBlockSpec(
  { type: CUSTOM.page, propSchema: { variant: { default: "page" } }, content: "none" },
  { render: ({ block }) => <Atom kind="page"><PageLink id={block.id} /></Atom> },
);

// MARK: Link zu Seite

function PagePicker(props: { onPick: (id: string) => void; exclude?: string }) {
  const env = useEnv();
  const [q, setQ] = useState("");
  const pages = [...env.store.blocks.values()]
    .filter((b) => (b.type === "page" || b.type === "databasePage") && b.trashedAt === undefined && b.id !== props.exclude)
    .filter((b) => pageTitle(b).toLowerCase().includes(q.toLowerCase()))
    .slice(0, 8);
  return (
    <div className="bx-picker">
      <input className="bx-field" autoFocus placeholder="Link to page…" value={q} onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && pages[0]) props.onPick(pages[0].id);
        }} />
      <ul className="bx-picker-list">
        {pages.map((p) => (
          <li key={p.id}><button type="button" onClick={() => props.onPick(p.id)}><IconView icon={pageIcon(p)} fallback="📄" /> {pageTitle(p)}</button></li>
        ))}
      </ul>
    </div>
  );
}

export const linkToPageBlock = createReactBlockSpec(
  { type: CUSTOM.linkToPage, propSchema: { target: { default: "" } }, content: "none" },
  {
    render: ({ block, editor }) => (
      <Atom kind="linkToPage">
        {block.props.target
          ? <><span className="bx-linkarrow" aria-hidden>↗</span><PageLink id={block.props.target} /></>
          : <PagePicker onPick={(id) => editor.updateBlock(block, { props: { target: id } })} />}
      </Atom>
    ),
  },
);

// MARK: Synced Block

function SyncedView(props: { id: string; source: string; editor: AnyEditor }) {
  const env = useEnv();
  useStoreRevision(env.store);
  const { store } = env;
  const root = props.source || props.id;
  const isCopy = props.source !== "";
  const missing = isCopy && !store.blocks.has(props.source);
  const loop = env.ancestors.includes(root) || root === env.rootID;
  // Liegt das Original (bzw. seine Seite) im Papierkorb? Dann wäre der Inhalt nur noch von hier aus bearbeitbar.
  const trashed = isCopy && !missing ? trashedRoot(store, props.source) : undefined;
  const home = isCopy && !missing ? containingPage(store, props.source) : undefined;
  const homeRef = usePageRef(env.pages, home ?? "");
  const homeTitle = home ? (homeRef && !homeRef.missing ? homeRef.title : pageTitle(store.blocks.get(home))) : undefined;
  const openHome = () => {
    if (!home) return;
    env.flush();
    env.onOpenPage?.(home);
  };
  const copy = async () => {
    const text = SYNC_CLIPBOARD_PREFIX + root;
    rememberSyncClipboard(text);
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
    } catch { /* ohne Berechtigung: „Paste synced block“ im Slash-Menü */ }
    env.notify("Copied. Paste on another page to sync this block there.");
  };
  const unsync = () => {
    env.flush();
    // Erst den Inhalt als eigene Kopie in den Store, dann zeigt der Block nicht mehr auf das Original.
    if (unsyncCopy(store, props.id, { undoable: false })) props.editor.updateBlock(props.id, { props: { source: "" } });
  };
  return (
    <div className="bx-synced" data-copy={isCopy ? "true" : "false"} data-trashed={trashed ? "true" : undefined} contentEditable={false}>
      <div className="bx-synced-label">
        <span>{isCopy ? "Synced copy" : "Synced block"}</span>
        {isCopy && home && !trashed ? (
          <button type="button" className="bx-synced-action" onClick={openHome} title="Open the page with the original">Original in {homeTitle}</button>
        ) : null}
        {env.editable && !missing ? <button type="button" className="bx-synced-action" onClick={() => void copy()}>Copy and sync</button> : null}
        {env.editable && isCopy ? <button type="button" className="bx-synced-action" onClick={unsync}>Unsync</button> : null}
      </div>
      {trashed ? (
        <div className="bx-synced-note" role="status">
          The original of this synced block is in the Trash{homeTitle ? ` (${homeTitle})` : ""}. Restore it there, or unsync to keep the content here.
        </div>
      ) : null}
      {missing ? <div className="bx-muted bx-synced-note">The original synced block was deleted.</div>
        : loop ? <div className="bx-muted bx-synced-note">This synced block contains itself.</div>
          : env.renderSynced(root, { readOnly: trashed !== undefined })}
    </div>
  );
}

export const syncedBlock = createReactBlockSpec(
  { type: CUSTOM.syncedBlock, propSchema: { source: { default: "" } }, content: "none" },
  { render: ({ block, editor }) => <SyncedView id={block.id} source={block.props.source} editor={editor} /> },
);

// MARK: Datenbank (Platzhalter; die Ansicht zeichnet ein anderes Paket)

function DatabaseView(props: { id: string; databaseID: string; viewID: string }) {
  const env = useEnv();
  useStoreRevision(env.store);
  const rec = env.store.blocks.get(props.id);
  const viewIDs = rec?.props?.viewIDs ?? (props.viewID ? [props.viewID] : []);
  const custom = env.renderDatabase?.({ blockID: props.id, databaseID: props.databaseID, viewID: props.viewID || viewIDs[0] || "", viewIDs });
  if (custom !== undefined && custom !== null) return <>{custom}</>;
  const db = env.store.databases.get(props.databaseID);
  return (
    <div className="bx-database-placeholder">
      <span aria-hidden>▦</span> {db ? plainText(db.title) || "Untitled database" : props.databaseID ? "Database not found" : "New database"}
    </div>
  );
}

export const databaseBlock = createReactBlockSpec(
  { type: CUSTOM.database, propSchema: { databaseID: { default: "" }, viewID: { default: "" } }, content: "none" },
  {
    render: ({ block }) => (
      <Atom kind="database" className="bx-database">
        <DatabaseView id={block.id} databaseID={block.props.databaseID} viewID={block.props.viewID} />
      </Atom>
    ),
  },
);

// MARK: Einbettungen (PDF, Embed, Lesezeichen)

/** BSD-208: PDF aus dem Asset-Speicher (oder per Link) im Block anzeigen; leer: Datei wählen oder Link einfügen. */
function PdfView(props: { id: string; url: string; editor: AnyEditor }) {
  const env = useEnv();
  const { editor } = props;
  const [src, setSrc] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    setSrc(undefined);
    if (!props.url) return;
    const resolve = editor.resolveFileUrl as ((u: string) => Promise<string>) | undefined;
    Promise.resolve(resolve ? resolve(props.url) : props.url).then((u) => live && setSrc(u), () => live && setError("This PDF can't be loaded right now."));
    return () => {
      live = false;
    };
  }, [props.url, editor]);
  const upload = editor.uploadFile as ((f: File, blockId?: string) => Promise<string | Record<string, unknown>>) | undefined;
  const pick = async (file: File | undefined) => {
    if (!file || !upload) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await upload(file, props.id);
      const url = typeof r === "string" ? r : String((r as { props?: { url?: string } }).props?.url ?? "");
      if (url) editor.updateBlock(props.id, { props: { url } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (!props.url) {
    if (!env.editable) return <span className="bx-muted">Empty PDF</span>;
    return (
      <div className="bx-pdf-empty">
        {upload ? (
          <>
            <button type="button" className="bx-button" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : "Upload PDF"}</button>
            <input ref={input} type="file" accept="application/pdf,.pdf" hidden aria-label="Upload PDF" onChange={(e) => void pick(e.target.files?.[0])} />
          </>
        ) : null}
        <InlineField value="" placeholder="…or paste a link to a PDF" onDone={(v) => v && editor.updateBlock(props.id, { props: { url: v.trim() } })} />
        {error ? <span className="bx-muted" role="alert">{error}</span> : null}
      </div>
    );
  }
  return (
    <div className="bx-pdf">
      {src ? (
        <object className="bx-pdf-frame" data={src} type="application/pdf" aria-label="PDF">
          <a href={src} target="_blank" rel="noreferrer">Open PDF</a>
        </object>
      ) : <span className="bx-muted">{error ?? "Loading PDF…"}</span>}
    </div>
  );
}

function EmbedView(props: { id: string; kind: string; url: string; meta: string; editor: AnyEditor }) {
  const env = useEnv();
  useStoreRevision(env.store);
  if (props.kind === "pdf") return <PdfView id={props.id} url={props.url} editor={props.editor} />;
  if (!props.url) {
    if (!props.editor.isEditable) return <span className="bx-muted">Empty {props.kind}</span>;
    return <InlineField value="" placeholder={`Paste a link (${props.kind})…`} onDone={(v) => v && props.editor.updateBlock(props.id, { props: { url: v.trim() } })} />;
  }
  const meta = (bookmarkMeta(props.meta) ?? env.store.blocks.get(props.id)?.props?.bookmark) as BookmarkMeta | undefined;
  // BSD-209: bekannte Anbieter (YouTube, Vimeo, Loom, Figma, CodePen, Spotify, Google Maps) als eingebetteter Inhalt.
  const target = props.kind === "embed" ? embedTarget(props.url) : undefined;
  if (target) {
    return (
      <figure className="bx-embed" data-provider={target.provider}>
        <iframe className="bx-embed-frame" src={target.src} title={`${target.provider} embed`} style={{ aspectRatio: String(target.aspect) }}
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation allow-forms" allow="fullscreen; picture-in-picture; encrypted-media"
          referrerPolicy="strict-origin-when-cross-origin" loading="lazy" />
        <figcaption className="bx-muted bx-embed-caption"><a href={props.url} target="_blank" rel="noreferrer">{target.provider} · {props.url}</a></figcaption>
      </figure>
    );
  }
  const card = (
    <a className="bx-embed-card" href={props.url} target="_blank" rel="noreferrer">
      <span className="bx-embed-kind">{props.kind}</span>
      <span className="bx-embed-title">{meta?.title ?? props.url}</span>
      {meta?.summary ? <span className="bx-muted bx-embed-summary">{meta.summary}</span> : null}
      {meta?.title ? <span className="bx-muted bx-embed-url">{props.url}</span> : null}
    </a>
  );
  // BSD-209: Vorschau nur auf ausdrücklichen Klick holen (Regel „Netz nur auf Nutzeraktion“), nur wo die Hülle das kann.
  if (props.kind !== "bookmark" || !env.fetchLinkPreview || !props.editor.isEditable) return card;
  return <BookmarkWithFetch id={props.id} url={props.url} hasMeta={meta?.title !== undefined} editor={props.editor}>{card}</BookmarkWithFetch>;
}

function BookmarkWithFetch(props: { id: string; url: string; hasMeta: boolean; editor: AnyEditor; children: ReactNode }) {
  const env = useEnv();
  const [busy, setBusy] = useState(false);
  // BSD-363: nach dem Aushängen (Block gelöscht, Seite gewechselt) keinen Zustand mehr setzen.
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const fetchPreview = async () => {
    const fetchLink = env.fetchLinkPreview;
    if (busy || !fetchLink) return;
    setBusy(true);
    await fetchBookmarkPreview(props.url, {
      fetch: fetchLink,
      exists: () => mounted.current && props.editor.getBlock(props.id) !== undefined,
      apply: (m) => props.editor.updateBlock(props.id, { props: { meta: canonicalStringify(m) } } as never),
      notify: env.notify,
    });
    if (mounted.current) setBusy(false);
  };
  return (
    <div className="bx-bookmark">
      {props.children}
      <button type="button" className="bx-button bx-bookmark-fetch" disabled={busy} onClick={() => void fetchPreview()}>
        {busy ? "Fetching preview…" : props.hasMeta ? "Refresh preview" : "Fetch preview"}
      </button>
    </div>
  );
}

export const embedBlock = createReactBlockSpec(
  { type: CUSTOM.embed, propSchema: { kind: { default: "embed" }, url: { default: "" }, meta: { default: "" } }, content: "none" },
  { render: ({ block, editor }) => <Atom kind="embed"><EmbedView id={block.id} kind={block.props.kind} url={block.props.url} meta={block.props.meta} editor={editor} /></Atom> },
);

// MARK: Inhaltsverzeichnis, Breadcrumb, Button

function TocView() {
  const env = useEnv();
  useStoreRevision(env.store);
  const out = headingOutline(env.store, env.rootID);
  if (out.length === 0) return <span className="bx-muted">Add headings to create a table of contents.</span>;
  return (
    <ul className="bx-toc">
      {out.map((h) => (
        <li key={h.id} data-level={h.depth + 1}>
          <a href={"#" + h.id} onClick={(e) => {
            e.preventDefault();
            scrollToHeading(null, h.id);
          }}>{h.title}</a>
        </li>
      ))}
    </ul>
  );
}

export const tocBlock = createReactBlockSpec(
  { type: CUSTOM.toc, propSchema: {}, content: "none" },
  { render: () => <Atom kind="toc"><TocView /></Atom> },
);

function BreadcrumbView() {
  const env = useEnv();
  useStoreRevision(env.store);
  const path: Block[] = [];
  let cur = env.store.blocks.get(env.rootID);
  for (let n = 0; cur && n < 64; n++) {
    if (cur.type === "page" || cur.type === "databasePage") path.unshift(cur);
    cur = cur.parent.startsWith("b:") ? env.store.blocks.get(cur.parent.slice(2)) : undefined;
  }
  return (
    <nav className="bx-breadcrumb" aria-label="Breadcrumb">
      {path.map((p, i) => (
        <span key={p.id}>{i > 0 ? <span className="bx-muted"> / </span> : null}<PageLink id={p.id} /></span>
      ))}
    </nav>
  );
}

export const breadcrumbBlock = createReactBlockSpec(
  { type: CUSTOM.breadcrumb, propSchema: {}, content: "none" },
  { render: () => <Atom kind="breadcrumb"><BreadcrumbView /></Atom> },
);

export const buttonBlock = createReactBlockSpec(
  { type: CUSTOM.button, propSchema: {}, content: "none" },
  { render: ({ block, editor }) => <Atom kind="button"><ButtonBlockView id={block.id} editor={editor as unknown as CaretEditor} /></Atom> },
);

// MARK: Spalten (Kinder liegen nebeneinander, siehe styles.css)

export const columnListBlock = createReactBlockSpec(
  { type: CUSTOM.columnList, propSchema: {}, content: "none" },
  { render: () => <div className="bx-columns-handle" contentEditable={false} aria-label="Columns" /> },
);

/**
 * BSD-210: Spalte mit Breite. Der Anteil (`width` = Swift `ratio`) wird als Flex-Gewicht an den Spaltenrahmen
 * geschrieben; rechts jeder Spalte außer der letzten liegt ein Griff zum Ziehen (Maus, Pfeiltasten) – ein Undo-Schritt.
 * Rechts, nicht links: links erscheint BlockNotes Blockgriff und läge darüber.
 */
function ColumnView(props: { editor: AnyEditor; id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const env = useEnv();
  const { editor, id } = props;
  // Während des Ziehens: Anteile aller Spalten (sonst gilt der gespeicherte Anteil).
  const [live, setLive] = useState<number[] | undefined>();
  const cols: { id: string; width: number }[] = (editor.getParentBlock(id)?.children ?? [])
    .map((b: { id: string; props: { width?: unknown } }) => ({ id: b.id, width: Number(b.props.width) || 0 }));
  const fractions = columnFractions(cols.map((c) => c.width));
  const index = cols.findIndex((c) => c.id === id);
  const save = (next: readonly number[]) => {
    editor.transact(() => cols.forEach((c, k) => editor.updateBlock(c.id, { props: { width: next[k] } })));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const row = (ref.current?.closest(".bn-block-outer") as HTMLElement | null)?.parentElement?.getBoundingClientRect().width;
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    let next = fractions;
    const move = (ev: PointerEvent) => {
      next = resizeColumns(fractions, index + 1, (ev.clientX - start) / row);
      setLive(next);
    };
    const up = () => {
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", up);
      setLive(undefined);
      if (next !== fractions) save(next);
    };
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", up);
  };
  // Breite als Flex-Gewicht über eine Regel am Spaltenrahmen (dessen DOM gehört ProseMirror, nicht anfassen).
  const sel = (cid: string) => `[data-id="${CSS.escape(cid)}"]`;
  let rules = index >= 0 ? `${sel(id)} { --bx-col: ${fractions[index]}; }` : "";
  if (live) rules += cols.map((c, k) => `${sel(c.id)}${sel(c.id)} { --bx-col: ${live[k]}; }`).join("\n");
  return (
    <div className="bx-column-handle" ref={ref} contentEditable={false} aria-label="Column">
      <style>{rules}</style>
      {env.editable && index >= 0 && index < cols.length - 1 ? (
        <div className="bx-column-resize" role="separator" aria-orientation="vertical" aria-label="Resize column" tabIndex={0}
          aria-valuenow={Math.round((fractions[index] ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}
          onPointerDown={onPointerDown}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            save(resizeColumns(fractions, index + 1, e.key === "ArrowRight" ? 0.05 : -0.05));
          }} />
      ) : null}
    </div>
  );
}

export const columnBlock = createReactBlockSpec(
  { type: CUSTOM.column, propSchema: { width: { default: 0 } }, content: "none" },
  { render: ({ block, editor }) => <ColumnView editor={editor as AnyEditor} id={block.id} /> },
);

// MARK: Unbekannt / nur in der App bearbeitbar

export const opaqueBlock = createReactBlockSpec(
  { type: CUSTOM.opaque, propSchema: { blockType: { default: "" }, raw: { default: "{}" } }, content: "none" },
  {
    render: ({ block }) => (
      <Atom kind="opaque" className="bx-opaque">
        <span className="bx-opaque-type">{block.props.blockType || "block"}</span>
        <span className="bx-muted"> · shown in the app</span>
      </Atom>
    ),
  },
);
