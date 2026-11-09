// Lese-Darstellung der Blöcke einer Seite, bis @based/editor eingesteckt wird (src/slots.ts). Arbeitet auf der
// Seiten-Replik; Häkchen an To-dos schreiben über die Replik in den Worker (gleicher Weg wie später der Editor).
import { plainText as richPlain, titleOf, type Block, type RichText, type WorkspaceStore } from "@based/core";
import type { ReactNode } from "react";
import { Icon } from "../icons.js";

interface Props {
  store: WorkspaceStore;
  pageID: string;
  readOnly: boolean;
  onOpenPage: (id: string) => void;
}

function Rich({ text, store, onOpenPage }: { text: RichText | undefined; store: WorkspaceStore; onOpenPage: (id: string) => void }) {
  if (text === undefined) return null;
  if (typeof text === "string") return <>{text}</>;
  return (
    <>
      {text.map((r, i) => {
        const m = r.mention as Record<string, { _0: unknown }> | undefined;
        if (m?.page) {
          const id = String(m.page._0);
          return <button key={i} type="button" className="mention" onClick={() => onOpenPage(id)}>{titleOf(store, id)}</button>;
        }
        let node: ReactNode = r.t ?? (r.eq !== undefined ? r.eq : m?.link ? String(m.link._0) : "");
        if (r.m?.c) node = <code className="t-code">{node}</code>;
        if (r.m?.b) node = <strong>{node}</strong>;
        if (r.m?.i) node = <em>{node}</em>;
        if (r.m?.s) node = <s>{node}</s>;
        if (r.m?.u) node = <u>{node}</u>;
        if (r.m?.link) node = <a href={r.m.link} target="_blank" rel="noreferrer noopener">{node}</a>;
        return <span key={i}>{node}</span>;
      })}
    </>
  );
}

export function BlockView({ store, pageID, readOnly, onOpenPage }: Props) {
  const kids = store.children("b:" + pageID);
  if (kids.length === 0) return <p className="t-desc empty-page">This page is empty.</p>;
  return <div className="blocks t-body"><Blocks ids={kids} store={store} readOnly={readOnly} onOpenPage={onOpenPage} /></div>;
}

function Blocks({ ids, store, readOnly, onOpenPage }: { ids: readonly string[]; store: WorkspaceStore; readOnly: boolean; onOpenPage: (id: string) => void }) {
  const out: ReactNode[] = [];
  let n = 0;
  for (const id of ids) {
    const b = store.blocks.get(id);
    if (!b || b.trashedAt !== undefined) continue;
    n = b.type === "numberedList" ? n + 1 : 0;
    out.push(<BlockItem key={id} b={b} index={n} store={store} readOnly={readOnly} onOpenPage={onOpenPage} />);
  }
  return <>{out}</>;
}

function BlockItem({ b, index, store, readOnly, onOpenPage }: { b: Block; index: number; store: WorkspaceStore; readOnly: boolean; onOpenPage: (id: string) => void }) {
  const text = <Rich text={b.text} store={store} onOpenPage={onOpenPage} />;
  const kids = store.children("b:" + b.id);
  const nested = kids.length && b.type !== "page" && b.type !== "databasePage" ? (
    <div className="block-children"><Blocks ids={kids} store={store} readOnly={readOnly} onOpenPage={onOpenPage} /></div>
  ) : null;
  switch (b.type) {
    case "heading1": return <><h2 className="t-heading block-h1">{text}</h2>{nested}</>;
    case "heading2": return <><h3 className="t-heading block-h2">{text}</h3>{nested}</>;
    case "heading3": case "heading4": return <><h4 className="t-section block-h3">{text}</h4>{nested}</>;
    case "bulletedList": return <div className="block-li"><span className="bullet" aria-hidden="true">•</span><div>{text}{nested}</div></div>;
    case "numberedList": return <div className="block-li"><span className="bullet t-data" aria-hidden="true">{index}.</span><div>{text}{nested}</div></div>;
    case "todo": {
      const checked = b.props?.checked === true;
      const toggle = () => store.transact("Check", (tx) => tx.update(b.id, (x) => { x.props = { ...(x.props ?? {}), checked: !checked }; }));
      return (
        <div>
          <label className={checked ? "todo done" : "todo"}>
            <input type="checkbox" checked={checked} disabled={readOnly} onChange={toggle} />
            <span>{text}</span>
          </label>
          {nested}
        </div>
      );
    }
    case "quote": return <blockquote className="block-quote">{text}{nested}</blockquote>;
    case "callout": return <div className="block-callout">{text}{nested}</div>;
    case "code": return <pre className="code-block t-code">{richPlain(b.text)}</pre>;
    case "divider": return <hr className="block-divider" />;
    case "toggle": return <details className="block-toggle" open={b.props?.isOpen === true}><summary>{text}</summary>{nested}</details>;
    case "page": case "databasePage":
      return (
        <button type="button" className="block-page" onClick={() => onOpenPage(b.id)}>
          <Icon name={b.type === "page" ? "page" : "database"} size={18} />
          <span>{titleOf(store, b.id)}</span>
        </button>
      );
    case "linkToPage": {
      const target = b.props?.linkTarget;
      return target ? <button type="button" className="block-page" onClick={() => onOpenPage(target)}><Icon name="page" size={18} /><span>{titleOf(store, target)}</span></button> : null;
    }
    case "image": case "video": case "audio": case "file": case "pdf": case "bookmark": case "embed": {
      const caption = richPlain(b.props?.caption) || b.props?.bookmark?.title || b.props?.url || b.props?.asset?.name || b.type;
      return <div className="block-media t-desc">{caption}</div>;
    }
    case "databaseInline": {
      const db = b.props?.databaseID ? store.databases.get(b.props.databaseID) : undefined;
      return <div className="block-media t-desc">{db ? richPlain(db.title) || "Untitled database" : "Database"}</div>;
    }
    case "columnList": case "column": case "syncedBlock": return nested;
    default: return <><p>{text}</p>{nested}</>;
  }
}
