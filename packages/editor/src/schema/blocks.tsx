// BSD-154: Eigene Blocktypen (BlockNote-Kern, MPL-2.0; keine @blocknote/xl-*, ADR 0011). Darstellung nur mit
// Klassen aus styles.css (Tokens). Inhalte, die andere Pakete zeichnen (Datenbank-Ansicht, KaTeX), kommen über
// Callbacks aus dem EditorEnv.
import { defaultProps, type BlockNoteEditor } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { containingPage, headingOutline, plainText, trashedRoot, unsyncCopy, type Block } from "@based/core";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { CUSTOM, SYNC_CLIPBOARD_PREFIX } from "../mapping/bn.js";
import { useEnv, usePageRef, useStoreRevision } from "../ui/env.js";
import { scrollToHeading } from "../ui/Outline.js";
import { rememberSyncClipboard } from "../ui/syncClipboard.js";

const colorProps = { textColor: defaultProps.textColor, backgroundColor: defaultProps.backgroundColor };
const CALLOUT_ICONS = ["💡", "📌", "⚠️", "✅", "❗", "ℹ️"];

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

export const calloutBlock = createReactBlockSpec(
  { type: CUSTOM.callout, propSchema: { ...colorProps, icon: { default: "" } }, content: "inline" },
  {
    render: ({ block, editor, contentRef }) => {
      const icon = block.props.icon || CALLOUT_ICONS[0]!;
      const next = () => {
        const i = CALLOUT_ICONS.indexOf(icon);
        editor.updateBlock(block, { props: { icon: CALLOUT_ICONS[(i + 1) % CALLOUT_ICONS.length]! } });
      };
      return (
        <div className="bx-callout" data-color={block.props.backgroundColor}>
          <button type="button" className="bx-callout-icon" contentEditable={false} onClick={next} aria-label="Icon">{icon}</button>
          <div className="bx-callout-text" ref={contentRef} />
        </div>
      );
    },
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
      <span className="bx-pagelink-icon" aria-hidden>{pageIcon(rec)}</span>
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
          <li key={p.id}><button type="button" onClick={() => props.onPick(p.id)}>{pageIcon(p)} {pageTitle(p)}</button></li>
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

function EmbedView(props: { id: string; kind: string; url: string; editor: AnyEditor }) {
  const env = useEnv();
  useStoreRevision(env.store);
  if (!props.url) {
    if (!props.editor.isEditable) return <span className="bx-muted">Empty {props.kind}</span>;
    return <InlineField value="" placeholder={`Paste a link (${props.kind})…`} onDone={(v) => v && props.editor.updateBlock(props.id, { props: { url: v.trim() } })} />;
  }
  const meta = env.store.blocks.get(props.id)?.props?.bookmark;
  return (
    <a className="bx-embed-card" href={props.url} target="_blank" rel="noreferrer">
      <span className="bx-embed-kind">{props.kind}</span>
      <span className="bx-embed-title">{meta?.title ?? props.url}</span>
      {meta?.summary ? <span className="bx-muted">{meta.summary}</span> : null}
    </a>
  );
}

export const embedBlock = createReactBlockSpec(
  { type: CUSTOM.embed, propSchema: { kind: { default: "embed" }, url: { default: "" } }, content: "none" },
  { render: ({ block, editor }) => <Atom kind="embed"><EmbedView id={block.id} kind={block.props.kind} url={block.props.url} editor={editor} /></Atom> },
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

function ButtonView(props: { id: string }) {
  const env = useEnv();
  useStoreRevision(env.store);
  const label = env.store.blocks.get(props.id)?.props?.buttonLabel ?? "Button";
  return <span className="bx-button" title="Button actions run in the app">{label}</span>;
}

export const buttonBlock = createReactBlockSpec(
  { type: CUSTOM.button, propSchema: {}, content: "none" },
  { render: ({ block }) => <Atom kind="button"><ButtonView id={block.id} /></Atom> },
);

// MARK: Spalten (Kinder liegen nebeneinander, siehe styles.css)

export const columnListBlock = createReactBlockSpec(
  { type: CUSTOM.columnList, propSchema: {}, content: "none" },
  { render: () => <div className="bx-columns-handle" contentEditable={false} aria-label="Columns" /> },
);

export const columnBlock = createReactBlockSpec(
  { type: CUSTOM.column, propSchema: { width: { default: 0 } }, content: "none" },
  { render: () => <div className="bx-column-handle" contentEditable={false} aria-label="Column" /> },
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
