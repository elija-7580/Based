// BSD-155: Anzeige einer Zelle für alle Property-Typen (Swift Views/Database/Cells.swift).
import { memo, useContext, type ReactNode } from "react";
import {
  cellText, formatDateCell, formatNumber, formatValue, plainText, titleOf, valueCase,
  type Block, type FormulaRun, type PropertySchema, type Value,
} from "@based/core";
import { ShellSlots, useDB, type FileHost } from "../context.js";
import { hrefOf, storedFiles, storedIDs } from "../logic/values.js";
import { Icon, OptionPill } from "../ui.js";

/** Höchstens so viele verknüpfte Seiten je Zelle rendern (Rest als Zahl). */
const MAX_LINKS = 12;

export interface CellViewProps {
  row: Block;
  prop: PropertySchema;
  wrap?: boolean;
  /** Board/Galerie: kompakte Darstellung, leere Werte gar nicht. */
  compact?: boolean;
  onToggleCheckbox?: () => void;
  onButton?: () => void;
}

function RichRuns({ runs }: { runs: FormulaRun[] }) {
  return (
    <>
      {runs.map((r, i) => {
        const m = r.m ?? {};
        const cls = [m.b && "b", m.i && "i", m.u && "u", m.s && "s", m.c && "c", m.color && `tc-${m.color.replace(/Background$/, "")}`].filter(Boolean).join(" ");
        const inner = <span key={i} className={cls || undefined}>{r.t}</span>;
        return m.link ? <a key={i} href={hrefOf(m.link)} target="_blank" rel="noreferrer" className="dbui-link">{inner}</a> : inner;
      })}
    </>
  );
}

function Check({ checked, onToggle, disabled }: { checked: boolean; onToggle?: (() => void) | undefined; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} className={"dbui-check" + (checked ? " on" : "")} disabled={disabled || !onToggle}
      onClick={(e) => { e.stopPropagation(); onToggle?.(); }} aria-label={checked ? "Checked" : "Unchecked"}>
      {checked && <Icon name="check" size={12} />}
    </button>
  );
}

function ComputedValue({ v, prop, wrap }: { v: Value; prop: PropertySchema; wrap: boolean | undefined }) {
  const { engine } = useDB();
  if (v.t === "bool") return <Check checked={v.v} disabled />;
  if (v.t === "string" && v.rich) return <span className={wrap ? "dbui-wrap" : "dbui-clip"}><RichRuns runs={v.rich} /></span>;
  if (v.t === "number" || v.t === "date") return <span className="dbui-data">{formatValue(engine, v, prop)}</span>;
  return <span className={wrap ? "dbui-wrap" : "dbui-clip"}>{formatValue(engine, v, prop)}</span>;
}

/** BSD-208: hochgeladene Datei öffnen (Blob-URL aus dem Asset-Speicher der Shell) in einem neuen Fenster. */
function openAsset(host: FileHost, id: string) {
  void host.open(id).then((u) => globalThis.open?.(u, "_blank"), () => { /* nicht ladbar: nichts zu öffnen */ });
}

function CellViewInner({ row, prop, wrap, compact, onToggleCheckbox, onButton }: CellViewProps): ReactNode {
  const fileHost = useContext(ShellSlots).files;
  const { store, engine, db, onOpenPage, locked } = useDB();
  const cls = wrap ? "dbui-wrap" : "dbui-clip";
  switch (prop.type) {
    case "title": {
      const t = plainText(row.text);
      return t ? <span className={cls}>{t}</span> : compact ? <span className="dbui-muted">Untitled</span> : <span className="dbui-muted">Untitled</span>;
    }
    case "select": case "status": {
      const id = valueCase(row.values?.[prop.id]);
      const o = id && (id[0] === "select" || id[0] === "status") ? prop.options?.find((x) => x.id === id[1]) : undefined;
      return o ? <OptionPill name={o.name} color={o.color} status={prop.type === "status"} /> : null;
    }
    case "multiSelect": {
      const ids = storedIDs(row, prop, "multiSelect");
      const opts = ids.flatMap((id) => prop.options?.find((o) => o.id === id) ?? []);
      return opts.length ? <span className={"dbui-pills" + (wrap ? " wrap" : "")}>{opts.map((o) => <OptionPill key={o.id} name={o.name} color={o.color} />)}</span> : null;
    }
    case "checkbox": {
      const c = valueCase(row.values?.[prop.id]);
      return <Check checked={c?.[0] === "checkbox" && c[1] === true} onToggle={locked ? undefined : onToggleCheckbox} />;
    }
    case "number": {
      const c = valueCase(row.values?.[prop.id]);
      return c?.[0] === "number" ? <span className="dbui-data dbui-num">{formatNumber(c[1] as number, prop.numberFormat)}</span> : null;
    }
    case "uniqueID": {
      const c = valueCase(row.values?.[prop.id]);
      return c?.[0] === "uniqueID" ? <span className="dbui-data">{(prop.idPrefix ? prop.idPrefix + "-" : "") + String(c[1])}</span> : null;
    }
    case "date": {
      const c = valueCase(row.values?.[prop.id]);
      return c?.[0] === "date" ? <span className="dbui-data">{formatDateCell(c[1] as never, prop)}</span> : null;
    }
    case "createdTime": case "lastEditedTime": {
      const v = engine.value(row, prop, db);
      return v.t === "date" ? <span className="dbui-data">{formatDateCell(v.v, prop)}</span> : null;
    }
    case "person": case "createdBy": case "lastEditedBy": {
      const v = engine.value(row, prop, db);
      const people = v.t === "list" ? v.v : v.t === "empty" ? [] : [v];
      return people.length ? (
        <span className={"dbui-pills" + (wrap ? " wrap" : "")}>
          {people.map((p, i) => <span key={i} className="dbui-person"><span className="dbui-avatar" aria-hidden>{cellText(store, p).slice(0, 1).toUpperCase()}</span>{cellText(store, p)}</span>)}
        </span>
      ) : null;
    }
    case "files": {
      const files = storedFiles(row, prop);
      return files.length ? (
        <span className={"dbui-pills" + (wrap ? " wrap" : "")}>
          {files.map((f, i) => f.url
            ? <a key={i} className="dbui-file dbui-link" href={hrefOf(f.url)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}><Icon name="file" size={12} />{f.name}</a>
            : f.asset && fileHost
              ? <button key={i} type="button" className="dbui-file dbui-link" onClick={(e) => { e.stopPropagation(); openAsset(fileHost, f.asset!.id); }}><Icon name="file" size={12} />{f.name}</button>
              : <span key={i} className="dbui-file"><Icon name="file" size={12} />{f.name}</span>)}
        </span>
      ) : null;
    }
    case "url": case "email": case "phone": {
      const c = valueCase(row.values?.[prop.id]);
      const s = c && typeof c[1] === "string" ? c[1] : "";
      if (!s) return null;
      const href = prop.type === "url" ? hrefOf(s) : prop.type === "email" ? "mailto:" + s : "tel:" + s.replace(/\s/g, "");
      return <a className={"dbui-link " + cls} href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{s}</a>;
    }
    case "relation": {
      const v = engine.value(row, prop, db);
      const ids = v.t === "list" ? v.v.flatMap((x) => (x.t === "page" ? [x.v] : [])) : [];
      return ids.length ? (
        <span className={"dbui-pills" + (wrap ? " wrap" : "")}>
          {ids.slice(0, MAX_LINKS).map((id) => (
            <button key={id} type="button" className="dbui-relation" onClick={(e) => { e.stopPropagation(); onOpenPage?.(id); }}>
              <Icon name="open" size={12} />{titleOf(store, id)}
            </button>
          ))}
          {ids.length > MAX_LINKS && <span className="dbui-count">+{ids.length - MAX_LINKS}</span>}
        </span>
      ) : null;
    }
    case "formula": case "rollup": {
      const v = engine.value(row, prop, db);
      const err = engine.error(row.id, prop.id);
      if (v.t === "empty" && err) return <span className="dbui-error" title={err.message} role="img" aria-label={`Formula error: ${err.message}`}><Icon name="warning" size={14} /></span>;
      if (v.t === "empty") return null;
      return <ComputedValue v={v} prop={prop} wrap={wrap} />;
    }
    case "button":
      return <button type="button" className="dbui-btn small" disabled={locked} onClick={(e) => { e.stopPropagation(); onButton?.(); }}>{prop.name}</button>;
    default: {
      const v = engine.value(row, prop, db);
      const t = v.t === "empty" ? "" : cellText(store, v);
      return t ? <span className={cls}>{t}</span> : null;
    }
  }
}

export const CellView = memo(function CellView(props: CellViewProps) {
  return <>{CellViewInner(props)}</>;
});
