// BSD-155: Zellen-Editoren für alle bearbeitbaren Property-Typen. Jede Änderung geht über eine
// Store-Transaktion (setValue/setRelation/addOption); Text wird beim Schließen übernommen (wie Notion).
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  addOption, pv, rowsOf, setRelation, setValue, titleOf, valueCase,
  type Block, type DateValue, type PropertySchema,
} from "@based/core";
import { ShellSlots, useDB } from "../context.js";
import {
  editText, fromInputValue, parseTextInput, storedDate, storedFiles, type StoredFile, storedIDs, toInputValue, withDate,
} from "../logic/values.js";
import { Icon, OptionPill, Popover, type Anchor } from "../ui.js";
import { PlaceEditor } from "./PlaceEditor.js";

export interface CellEditorProps {
  row: Block;
  prop: PropertySchema;
  anchor: Anchor;
  onClose: () => void;
  /** Text-Editoren: nach Enter zur nächsten Zeile (Tabelle). */
  onCommitNext?: () => void;
  /** Erstes getipptes Zeichen, das den Editor geöffnet hat. */
  initialText?: string | undefined;
}

/** Hat der Typ einen Editor (sonst: nur anzeigen bzw. Checkbox direkt umschalten)? */
export function isEditable(type: string): boolean {
  return ["title", "text", "number", "url", "email", "phone", "place", "select", "multiSelect", "status", "date", "person", "files", "relation"].includes(type);
}

export function CellEditor(props: CellEditorProps) {
  switch (props.prop.type) {
    case "title": case "text": case "number": case "url": case "email": case "phone": return <TextEditor {...props} />;
    case "place": return <PlaceEditor {...props} />;
    case "select": case "status": case "multiSelect": return <OptionsEditor {...props} />;
    case "date": return <DateEditor {...props} />;
    case "person": return <ListEditor {...props} kind="person" />;
    case "files": return <FilesEditor {...props} />;
    case "relation": return <RelationEditor {...props} />;
    default: return null;
  }
}

function TextEditor({ row, prop, anchor, onClose, onCommitNext, initialText }: CellEditorProps) {
  const { store } = useDB();
  const [text, setText] = useState(initialText ?? editText(row, prop));
  const [invalid, setInvalid] = useState(false);
  const done = useRef(false);
  const field = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // Einmal beim Öffnen: Cursor ans Ende (nach dem Autofokus des Popovers).
  useEffect(() => { const el = field.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, []);
  const commit = () => {
    if (done.current) return true;
    if (text === editText(row, prop)) { done.current = true; return true; }
    const v = parseTextInput(prop.type, text);
    if (v === undefined) { setInvalid(true); return false; }
    done.current = true;
    if (prop.type === "title") store.setText(row.id, text);
    else setValue(store, row.id, prop.id, v);
    return true;
  };
  const multiline = prop.type === "text";
  const common = {
    className: "dbui-input" + (invalid ? " invalid" : ""),
    value: text,
    "aria-label": prop.name,
    "aria-invalid": invalid || undefined,
    onChange: (e: { target: { value: string } }) => { setText(e.target.value); setInvalid(false); },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !(multiline && e.shiftKey)) {
        e.preventDefault();
        if (commit()) { onClose(); onCommitNext?.(); }
      }
    },
    ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => { field.current = el; },
  };
  return (
    <Popover anchor={anchor} onClose={() => { commit(); onClose(); }} cover matchWidth className="dbui-cell-editor" label={`Edit ${prop.name}`}>
      {multiline ? <textarea rows={3} {...common} /> : <input type={prop.type === "number" ? "text" : prop.type === "email" ? "email" : "text"} inputMode={prop.type === "number" ? "decimal" : undefined} {...common} />}
      {invalid && <p className="dbui-hint danger">Enter a number</p>}
    </Popover>
  );
}

function OptionsEditor({ row, prop, anchor, onClose }: CellEditorProps) {
  const { store, db } = useDB();
  const [query, setQuery] = useState("");
  const multi = prop.type === "multiSelect";
  const live = db.properties.find((p) => p.id === prop.id) ?? prop;
  const current = useMemo(() => {
    if (multi) return storedIDs(row, live, "multiSelect");
    const c = valueCase(row.values?.[live.id]);
    return c && (c[0] === "select" || c[0] === "status") ? [c[1] as string] : [];
  }, [row, live, multi]);
  const options = live.options ?? [];
  const q = query.trim().toLocaleLowerCase();
  const matches = q ? options.filter((o) => o.name.toLocaleLowerCase().includes(q)) : options;
  const exact = options.some((o) => o.name.toLocaleLowerCase() === q);
  const write = (ids: string[]) => setValue(store, row.id, live.id, ids.length === 0 ? null : multi ? pv("multiSelect", ids) : pv(live.type, ids[0]));
  const choose = (id: string) => {
    if (multi) write(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
    else { write(current[0] === id ? [] : [id]); onClose(); }
    setQuery("");
  };
  const create = () => {
    const id = addOption(store, db.id, live.id, query);
    if (id) choose(id);
  };
  const groups = live.type === "status" && live.statusGroups?.length
    ? live.statusGroups.map((g) => ({ name: g.name, options: matches.filter((o) => g.optionIDs.includes(o.id)) })).filter((g) => g.options.length)
    : [{ name: "", options: matches }];
  return (
    <Popover anchor={anchor} onClose={onClose} matchWidth className="dbui-options-editor" label={`Edit ${live.name}`}>
      <div className="dbui-option-field">
        {current.map((id) => { const o = options.find((x) => x.id === id); return o ? <OptionPill key={id} name={o.name} color={o.color} status={live.type === "status"} onRemove={() => write(current.filter((x) => x !== id))} /> : null; })}
        <input className="dbui-input bare" placeholder={current.length ? "" : "Search or create an option"} value={query} aria-label="Search options"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (matches[0] && (exact || !q)) choose(matches.find((o) => o.name.toLocaleLowerCase() === q)?.id ?? matches[0].id);
              else if (q) create();
            } else if (e.key === "Backspace" && !query && current.length) write(current.slice(0, -1));
          }} />
      </div>
      <div className="dbui-menu-scroll" role="listbox" aria-label="Options" aria-multiselectable={multi}>
        {groups.map((g) => (
          <div key={g.name}>
            {g.name && <div className="dbui-menu-heading">{g.name}</div>}
            {g.options.map((o) => (
              <button key={o.id} type="button" role="option" aria-selected={current.includes(o.id)} className="dbui-menu-item" onClick={() => choose(o.id)}>
                <OptionPill name={o.name} color={o.color} status={live.type === "status"} />
                {current.includes(o.id) && <span className="dbui-menu-check"><Icon name="check" /></span>}
              </button>
            ))}
          </div>
        ))}
        {q && !exact && (
          <button type="button" className="dbui-menu-item" onClick={create}>
            <span className="dbui-menu-label">Create</span><OptionPill name={query.trim()} color="gray" />
          </button>
        )}
        {!q && options.length === 0 && <p className="dbui-hint">Type to create an option</p>}
      </div>
    </Popover>
  );
}

function DateEditor({ row, prop, anchor, onClose }: CellEditorProps) {
  const { store } = useDB();
  const d = storedDate(row, prop);
  const save = (next: DateValue | null) => setValue(store, row.id, prop.id, next ? pv("date", next) : null);
  const type = d?.includeTime ? "datetime-local" : "date";
  return (
    <Popover anchor={anchor} onClose={onClose} className="dbui-date-editor" label={`Edit ${prop.name}`}>
      <label className="dbui-field">
        <span className="dbui-field-label">{d?.end !== undefined ? "Start" : "Date"}</span>
        <input className="dbui-input" type={type} value={d ? toInputValue(d.start, d.includeTime) : ""} aria-label={`${prop.name} start`}
          onChange={(e) => { const s = fromInputValue(e.target.value); if (s !== undefined) save(withDate(d, { start: s })); }} />
      </label>
      {d?.end !== undefined && (
        <label className="dbui-field">
          <span className="dbui-field-label">End</span>
          <input className="dbui-input" type={type} value={toInputValue(d.end, d.includeTime)} aria-label={`${prop.name} end`}
            onChange={(e) => { const s = fromInputValue(e.target.value); if (s !== undefined) save(withDate(d, { end: s })); }} />
        </label>
      )}
      <div className="dbui-toggles">
        <label className="dbui-toggle"><input type="checkbox" checked={d?.end !== undefined} onChange={(e) => save(withDate(d, e.target.checked ? { end: d?.start ?? withDate(undefined, {}).start } : { end: undefined }))} />End date</label>
        <label className="dbui-toggle"><input type="checkbox" checked={d?.includeTime ?? false} onChange={(e) => save(withDate(d, { includeTime: e.target.checked }))} />Include time</label>
      </div>
      <div className="dbui-row-actions">
        <button type="button" className="dbui-btn ghost" onClick={() => save(withDate(undefined, { includeTime: d?.includeTime ?? false }))}>Today</button>
        <button type="button" className="dbui-btn ghost" disabled={!d} onClick={() => { save(null); onClose(); }}>Clear</button>
      </div>
    </Popover>
  );
}

function ListEditor({ row, prop, anchor, onClose, kind }: CellEditorProps & { kind: "person" }) {
  const { store } = useDB();
  const ids = storedIDs(row, prop, kind);
  const [text, setText] = useState("");
  const save = (next: string[]) => setValue(store, row.id, prop.id, next.length ? pv(kind, next) : null);
  const add = (id: string) => { const t = id.trim(); if (t && !ids.includes(t)) save([...ids, t]); setText(""); };
  return (
    <Popover anchor={anchor} onClose={onClose} matchWidth label={`Edit ${prop.name}`}>
      <div className="dbui-option-field">
        {ids.map((id) => <OptionPill key={id} name={id === "me" ? "Me" : id} color="gray" onRemove={() => save(ids.filter((x) => x !== id))} />)}
        <input className="dbui-input bare" value={text} placeholder="Add a person" aria-label="Add a person" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(text); } }} />
      </div>
      {!ids.includes("me") && <button type="button" className="dbui-menu-item" onClick={() => add("me")}><Icon name="person" />Me</button>}
    </Popover>
  );
}

function FilesEditor({ row, prop, anchor, onClose }: CellEditorProps) {
  const { store } = useDB();
  const host = useContext(ShellSlots).files;
  const files = storedFiles(row, prop);
  const [url, setURL] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);
  const save = (next: StoredFile[]) => setValue(store, row.id, prop.id, next.length ? pv("files", next) : null);
  // BSD-208: hochladen → Asset-Speicher der Shell; im Wert wie Swift `{name, asset: {id, name, size, mime}}`.
  const upload = async (list: FileList | null) => {
    if (!host || !list?.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const added: StoredFile[] = [];
      for (const f of [...list]) {
        const id = await host.upload(f);
        added.push({ name: f.name, asset: { id, name: f.name, size: f.size, ...(f.type ? { mime: f.type } : {}) } });
      }
      save([...storedFiles(store.blocks.get(row.id) ?? row, prop), ...added]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const u = url.trim();
    if (!u) return;
    save([...files, { name: name.trim() || u.split("/").filter(Boolean).pop() || u, url: u }]);
    setURL(""); setName("");
  };
  return (
    <Popover anchor={anchor} onClose={onClose} label={`Edit ${prop.name}`} className="dbui-files-editor">
      {files.map((f, i) => (
        <div key={i} className="dbui-menu-item static">
          <Icon name="file" /><span className="dbui-menu-label">{f.name}</span>
          <button type="button" className="dbui-icon-btn" aria-label={`Remove ${f.name}`} onClick={() => save(files.filter((_, j) => j !== i))}><Icon name="trash" size={14} /></button>
        </div>
      ))}
      <input className="dbui-input" placeholder="Paste a link" aria-label="File link" value={url} onChange={(e) => setURL(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
      <input className="dbui-input" placeholder="Name (optional)" aria-label="File name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); }} />
      <button type="button" className="dbui-btn" onClick={add} disabled={!url.trim()}>Add link</button>
      {host ? (
        <>
          <button type="button" className="dbui-btn" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Uploading…" : "Upload file"}</button>
          <input ref={input} type="file" multiple hidden aria-label="Upload file" onChange={(e) => void upload(e.target.files)} />
        </>
      ) : null}
      {error ? <p role="alert" className="dbui-error">{error}</p> : null}
    </Popover>
  );
}

const RELATION_LIMIT = 50;

function RelationEditor({ row, prop, anchor, onClose }: CellEditorProps) {
  const { store, db } = useDB();
  const live = db.properties.find((p) => p.id === prop.id) ?? prop;
  const target = live.relation ? store.databases.get(live.relation.databaseID) : undefined;
  const ids = storedIDs(row, live, "relation");
  const [query, setQuery] = useState("");
  const candidates = useMemo(() => {
    if (!target) return [];
    const q = query.trim().toLocaleLowerCase();
    const out: Block[] = [];
    for (const r of rowsOf(store, target.id)) {
      if (r.props?.isTemplate || ids.includes(r.id)) continue;
      if (q && !titleOf(store, r.id).toLocaleLowerCase().includes(q)) continue;
      out.push(r);
      if (out.length >= RELATION_LIMIT) break;
    }
    return out;
  }, [store, target, query, ids]);
  if (!target) {
    return (
      <Popover anchor={anchor} onClose={onClose} label={`Edit ${live.name}`}>
        <p className="dbui-hint">Choose a database for this relation in the property settings.</p>
      </Popover>
    );
  }
  return (
    <Popover anchor={anchor} onClose={onClose} matchWidth className="dbui-relation-editor" label={`Edit ${live.name}`}>
      <input className="dbui-input" placeholder={`Link a page in ${titleOf(store, target.blockID)}`} aria-label="Search pages" value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && candidates[0]) setRelation(store, row.id, live.id, [...ids, candidates[0].id]); }} />
      {ids.length > 0 && <div className="dbui-menu-heading">Linked</div>}
      {ids.map((id) => (
        <div key={id} className="dbui-menu-item static">
          <Icon name="open" /><span className="dbui-menu-label">{titleOf(store, id)}</span>
          <button type="button" className="dbui-icon-btn" aria-label={`Unlink ${titleOf(store, id)}`} onClick={() => setRelation(store, row.id, live.id, ids.filter((x) => x !== id))}><Icon name="close" size={14} /></button>
        </div>
      ))}
      <div className="dbui-menu-heading">{live.relation?.limitOne ? "Pick one page" : "Pages"}</div>
      <div className="dbui-menu-scroll" role="listbox" aria-label="Pages">
        {candidates.map((r) => (
          <button key={r.id} type="button" role="option" aria-selected={false} className="dbui-menu-item" onClick={() => setRelation(store, row.id, live.id, [...ids, r.id])}>
            <Icon name="plus" /><span className="dbui-menu-label">{titleOf(store, r.id)}</span>
          </button>
        ))}
        {candidates.length === 0 && <p className="dbui-hint">No pages</p>}
      </div>
    </Popover>
  );
}
