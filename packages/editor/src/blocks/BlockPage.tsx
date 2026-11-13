// BSD-381 (ADR 0016, E0): Gerüst des neuen Block-Editors. Jeder Block ist eine eigene Einheit mit stabiler
// `data-block-id`, gerendert direkt aus den Records im Store (kein zweites Dokumentmodell). In E0 nur Anzeige:
// Textfelder, Fokus-Manager und Tastatur kommen in E2, Auswahl in E3, Griff und Ziehen in E4 (eigene Ebene über den
// Blöcken). Eingebettete Blöcke (Inline-Datenbank) zeichnet die Hülle über `renderDatabase`.
import { titleOf, type Block, type RichText, type WorkspaceStore } from "@based/core";
import { useCallback, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { DatabaseRenderProps } from "../ui/env.js";
import { blockTree, type BlockNode } from "./tree.js";
import "./blocks.css";

export interface BlockPageProps {
  store: WorkspaceStore;
  pageID: string;
  /** In E0 ohne Wirkung (nur Anzeige); ab E2 schaltet es die Textfelder frei. */
  editable: boolean;
  onOpenPage?: ((pageID: string) => void) | undefined;
  renderDatabase?: ((p: DatabaseRenderProps) => ReactNode) | undefined;
}

interface Ctx {
  store: WorkspaceStore;
  onOpenPage?: ((pageID: string) => void) | undefined;
  renderDatabase?: ((p: DatabaseRenderProps) => ReactNode) | undefined;
}

/** Zählt Änderungen am Store, damit die Seite neu zeichnet (E0: ganze Seite; ab E2 pro Block). */
function useStoreVersion(store: WorkspaceStore): number {
  const version = useRef(0);
  const subscribe = useCallback((notify: () => void) => store.observe(() => { version.current += 1; notify(); }), [store]);
  return useSyncExternalStore(subscribe, () => version.current);
}

export function BlockPage(props: BlockPageProps) {
  useStoreVersion(props.store);
  const tree = blockTree(props.store, props.pageID);
  const ctx: Ctx = { store: props.store, onOpenPage: props.onOpenPage, renderDatabase: props.renderDatabase };
  return (
    <div className="bx-blocks t-body" data-editor="blocks" data-page-id={props.pageID} aria-label="Page content">
      {tree.length === 0 ? <p className="bx-b-empty">This page is empty.</p> : <Blocks nodes={tree} ctx={ctx} />}
    </div>
  );
}

function Blocks({ nodes, ctx }: { nodes: readonly BlockNode[]; ctx: Ctx }) {
  let n = 0;
  return (
    <>
      {nodes.map((node) => {
        n = node.type === "numberedList" ? n + 1 : 0;
        return <BlockItem key={node.id} node={node} index={n} ctx={ctx} />;
      })}
    </>
  );
}

function Rich({ text, ctx }: { text: RichText | undefined; ctx: Ctx }) {
  if (text === undefined) return null;
  if (typeof text === "string") return <>{text}</>;
  return (
    <>
      {text.map((r, i) => {
        const m = r.mention as Record<string, { _0: unknown }> | undefined;
        if (m?.page) {
          const id = String(m.page._0);
          return <span key={i} className="bx-b-mention" data-page={id}>{titleOf(ctx.store, id)}</span>;
        }
        let node: ReactNode = r.t ?? (r.eq !== undefined ? r.eq : m?.link ? String(m.link._0) : "");
        if (r.m?.c) node = <code className="bx-b-code-inline">{node}</code>;
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

function BlockItem({ node, index, ctx }: { node: BlockNode; index: number; ctx: Ctx }) {
  const b = ctx.store.blocks.get(node.id);
  if (!b) return null;
  const text = <Rich text={b.text} ctx={ctx} />;
  const kids = node.children.length ? <div className="bx-b-children"><Blocks nodes={node.children} ctx={ctx} /></div> : null;
  const attrs = { "data-block-id": b.id, "data-block-type": b.type };
  switch (b.type) {
    case "text": return <div {...attrs} className="bx-b bx-b-text"><p className="bx-b-line">{text}</p>{kids}</div>;
    case "heading1": return <div {...attrs} className="bx-b bx-b-h1"><h2 className="bx-b-line">{text}</h2>{kids}</div>;
    case "heading2": return <div {...attrs} className="bx-b bx-b-h2"><h3 className="bx-b-line">{text}</h3>{kids}</div>;
    case "heading3": case "heading4": return <div {...attrs} className="bx-b bx-b-h3"><h4 className="bx-b-line">{text}</h4>{kids}</div>;
    case "bulletedList": return <ListItem attrs={attrs} marker={<span className="bx-b-bullet" />} text={text} kids={kids} />;
    case "numberedList": return <ListItem attrs={attrs} marker={<span className="bx-b-number">{index}.</span>} text={text} kids={kids} />;
    case "todo": {
      const checked = b.props?.checked === true;
      return <ListItem attrs={attrs} marker={<span className="bx-b-check" data-checked={checked || undefined} role="checkbox" aria-checked={checked} aria-label="To-do" />} text={text} kids={kids} done={checked} />;
    }
    case "toggle": return <ListItem attrs={attrs} marker={<span className="bx-b-toggle" aria-hidden="true" />} text={text} kids={kids} />;
    case "quote": return <div {...attrs} className="bx-b bx-b-quote"><p className="bx-b-line">{text}</p>{kids}</div>;
    case "callout": {
      const icon = typeof b.props?.icon === "string" ? b.props.icon : "";
      return (
        <div {...attrs} className="bx-b bx-b-callout">
          {icon ? <span className="bx-b-callout-icon" aria-hidden="true">{icon}</span> : null}
          <div className="bx-b-callout-body"><p className="bx-b-line">{text}</p>{kids}</div>
        </div>
      );
    }
    case "code": return <div {...attrs} className="bx-b bx-b-codeblock"><pre><code>{typeof b.text === "string" ? b.text : text}</code></pre></div>;
    case "divider": return <div {...attrs} className="bx-b bx-b-divider"><hr /></div>;
    case "columnList": return <div {...attrs} className="bx-b bx-b-columns"><Blocks nodes={node.children} ctx={ctx} /></div>;
    case "column": {
      const ratio = typeof b.props?.ratio === "number" && b.props.ratio > 0 ? b.props.ratio : 1;
      return <div {...attrs} className="bx-b bx-b-column" style={{ flexGrow: ratio }}><Blocks nodes={node.children} ctx={ctx} /></div>;
    }
    case "table": return <div {...attrs} className="bx-b bx-b-table"><Table block={b} ctx={ctx} /></div>;
    case "databaseInline": {
      const databaseID = b.props?.databaseID;
      const viewIDs = Array.isArray(b.props?.viewIDs) ? b.props.viewIDs : [];
      const view = databaseID && ctx.renderDatabase ? ctx.renderDatabase({ blockID: b.id, databaseID, viewID: viewIDs[0] ?? "", viewIDs }) : null;
      return <div {...attrs} className="bx-b bx-b-embed">{view ?? <p className="bx-b-placeholder">{titleOf(ctx.store, b.id)}</p>}</div>;
    }
    case "page": case "databasePage": case "linkToPage": {
      const target = b.type === "linkToPage" && typeof b.props?.pageID === "string" ? b.props.pageID : b.id;
      return (
        <div {...attrs} className="bx-b bx-b-pagelink">
          <a href={"#page-" + target} className="bx-b-line" onClick={(e) => { if (ctx.onOpenPage) { e.preventDefault(); ctx.onOpenPage(target); } }}>{titleOf(ctx.store, target)}</a>
        </div>
      );
    }
    default:
      // E6 portiert die übrigen eingebetteten Blöcke; bis dahin ein ruhiger Platzhalter mit dem Typnamen.
      return <div {...attrs} className="bx-b bx-b-other"><p className="bx-b-placeholder">{typeLabel(b.type)}</p>{kids}</div>;
  }
}

function ListItem(p: { attrs: Record<string, string>; marker: ReactNode; text: ReactNode; kids: ReactNode; done?: boolean }) {
  return (
    <div {...p.attrs} className={"bx-b bx-b-item" + (p.done ? " done" : "")}>
      <div className="bx-b-row"><span className="bx-b-marker" aria-hidden={p.done === undefined ? true : undefined}>{p.marker}</span><p className="bx-b-line">{p.text}</p></div>
      {p.kids}
    </div>
  );
}

function Table({ block, ctx }: { block: Block; ctx: Ctx }) {
  const rows = ctx.store.children("b:" + block.id).map((id) => ctx.store.blocks.get(id)).filter((r): r is Block => !!r && r.type === "tableRow" && r.trashedAt === undefined);
  const cols = Math.max(1, block.props?.tableColumns ?? 0, ...rows.map((r) => r.props?.cells?.length ?? 0));
  const header = block.props?.tableHeaderRow === true;
  return (
    <table className="bx-b-tablegrid">
      <tbody>
        {rows.map((r, ri) => (
          <tr key={r.id} data-block-id={r.id} data-block-type="tableRow">
            {Array.from({ length: cols }, (_, ci) => {
              const cell = <Rich text={r.props?.cells?.[ci]} ctx={ctx} />;
              return header && ri === 0 ? <th key={ci} scope="col">{cell}</th> : <td key={ci}>{cell}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** „pageLink“ → „Page link“ */
function typeLabel(type: string): string {
  const words = type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
