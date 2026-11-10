// BSD-154: Erwähnungen (Seite, Person, Datum, Link) und Gleichungen im Text.
import { createReactInlineContentSpec } from "@blocknote/react";
import { useEffect, useRef, useState } from "react";
import { canonicalStringify, dateFromSwift, dateParts, withDateParts, type DateParts } from "@based/core";
import { INLINE } from "../mapping/bn.js";
import { isEmojiIcon, useEnv, usePageRef, useStoreRevision } from "../ui/env.js";
import { pageIcon, pageTitle } from "./blocks.js";

function formatDate(value: string): string {
  try {
    const d = JSON.parse(value) as { start: number; end?: number; includeTime?: boolean };
    const opts: Intl.DateTimeFormatOptions = d.includeTime
      ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric" };
    const f = (s: number) => dateFromSwift(s).toLocaleString(undefined, opts);
    return d.end !== undefined ? `${f(d.start)} → ${f(d.end)}` : f(d.start);
  } catch {
    return value;
  }
}

/** Emoji-Icon einer Seite; Symbolnamen (ASCII) kann der Editor nicht zeichnen, dann das Standardzeichen. */
function mentionIcon(icon: string | undefined, kind: string | undefined): string {
  if (isEmojiIcon(icon)) return icon;
  return kind === "database" ? "▦" : "📄";
}

function PageMention(props: { id: string; text: string }) {
  const env = useEnv();
  useStoreRevision(env.store);
  const ref = usePageRef(env.pages, props.id);
  // Seiten im eigenen Store (Unterseiten) sind sofort da; alles andere kennt das Seitenverzeichnis der Shell.
  const local = env.store.blocks.get(props.id);
  const missing = ref ? ref.missing === true && !local : false;
  const trashed = ref?.trashed === true || (local ? local.trashedAt !== undefined : false);
  const title = (ref && !ref.missing ? ref.title : undefined) ?? (local ? pageTitle(local) : undefined) ?? (props.text || "Untitled");
  const icon = ref && !ref.missing ? mentionIcon(ref.icon, ref.kind) : local ? pageIcon(local) : "📄";
  const open = (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
    if (missing) return;
    env.flush();
    env.onOpenPage?.(props.id);
  };
  return (
    <span className="bx-mention" data-kind="page" data-page={props.id} data-trashed={trashed ? "true" : undefined} data-missing={missing ? "true" : undefined}
      role="link" tabIndex={-1} title={missing ? "This page no longer exists" : trashed ? "This page is in the Trash" : undefined}
      onClick={open} onKeyDown={(e) => e.key === "Enter" && open(e)}>
      <span className="bx-mention-icon" aria-hidden>{icon}</span>
      <span className="bx-mention-title">{title}</span>
      {missing ? <span className="bx-mention-flag">deleted</span> : trashed ? <span className="bx-mention-flag">in Trash</span> : null}
    </span>
  );
}

type DateProps = { start: number; end?: number; includeTime?: boolean; remind?: boolean };

/** Datums-Erwähnung: Klick öffnet den Wähler (Tag, Ende für einen Bereich, Uhrzeit) und die Erinnerungs-Flagge. */
function DateMention(props: { value: string; editable: boolean; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  let parsed: DateProps | undefined;
  try {
    parsed = JSON.parse(props.value) as DateProps;
  } catch { /* kaputter Wert: als Text zeigen */ }
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const remind = parsed?.remind === true;
  const toggle = (on: boolean) => {
    if (!parsed) return;
    const next: DateProps = { ...parsed };
    if (on) next.remind = true;
    else delete next.remind;
    props.onChange(canonicalStringify(next));
  };
  return (
    <span className="bx-mention" data-kind="date" data-remind={remind ? "true" : undefined} ref={ref}
      role={props.editable ? "button" : undefined} tabIndex={-1} aria-haspopup={props.editable ? "dialog" : undefined} aria-expanded={props.editable ? open : undefined}
      onClick={(e) => {
        if (!props.editable || !parsed) return;
        if ((e.target as Element).closest(".bx-date-pop")) return;
        e.preventDefault();
        setOpen(!open);
      }}>
      @{formatDate(props.value)}{remind ? <span className="bx-mention-remind" aria-label="Reminder set" title="Reminder set"> ⏰</span> : null}
      {open ? (
        <span className="bx-date-pop" role="dialog" aria-label="Date options" contentEditable={false} onKeyDown={(e) => { if (e.key !== "Escape") e.stopPropagation(); }}>
          {parsed ? <DatePicker value={parsed} onChange={(v) => props.onChange(canonicalStringify(v))} /> : null}
          <label className="bx-date-remind">
            <input type="checkbox" checked={remind} onChange={(e) => toggle(e.target.checked)} />
            <span>Remind me</span>
          </label>
          <span className="bx-muted">Saved with the date. Notifications come later.</span>
        </span>
      ) : null}
    </span>
  );
}

/** BSD-210: Tag, „End date“ (Bereich) und „Include time“ – native Felder, Wert wie in den Swift-Records. */
function DatePicker(props: { value: DateProps; onChange: (v: DateProps) => void }) {
  const parts = dateParts(props.value);
  const set = (patch: Partial<DateParts>) => props.onChange(withDateParts(props.value, { ...parts, ...patch }));
  const hasEnd = parts.endDay !== undefined;
  return (
    <span className="bx-date-picker">
      <span className="bx-date-row">
        <input type="date" className="bx-field" aria-label="Start day" value={parts.startDay} onChange={(e) => set({ startDay: e.target.value })} />
        {parts.includeTime ? <input type="time" className="bx-field" aria-label="Start time" value={parts.startTime} onChange={(e) => set({ startTime: e.target.value })} /> : null}
      </span>
      {hasEnd ? (
        <span className="bx-date-row">
          <input type="date" className="bx-field" aria-label="End day" value={parts.endDay} onChange={(e) => set({ endDay: e.target.value })} />
          {parts.includeTime ? <input type="time" className="bx-field" aria-label="End time" value={parts.endTime ?? parts.startTime} onChange={(e) => set({ endTime: e.target.value })} /> : null}
        </span>
      ) : null}
      <label className="bx-date-remind">
        <input type="checkbox" checked={hasEnd} onChange={(e) => set(e.target.checked ? { endDay: parts.startDay, endTime: parts.startTime } : { endDay: undefined, endTime: undefined })} />
        <span>End date</span>
      </label>
      <label className="bx-date-remind">
        <input type="checkbox" checked={parts.includeTime} onChange={(e) => set({ includeTime: e.target.checked, startTime: e.target.checked && parts.startTime === "00:00" ? "09:00" : parts.startTime })} />
        <span>Include time</span>
      </label>
    </span>
  );
}

function MentionView(props: { kind: string; value: string; text: string; editable: boolean; onChange: (value: string) => void }) {
  const env = useEnv();
  switch (props.kind) {
    case "page":
      return <PageMention id={props.value} text={props.text} />;
    case "user": {
      const name = env.people?.find((p) => p.id === props.value)?.name ?? props.text ?? props.value;
      return <span className="bx-mention" data-kind="user">@{name}</span>;
    }
    case "date":
      return <DateMention value={props.value} editable={props.editable && env.editable} onChange={props.onChange} />;
    default:
      return <a className="bx-mention" data-kind="link" href={props.value} target="_blank" rel="noreferrer">{props.text || props.value}</a>;
  }
}

export const mentionInline = createReactInlineContentSpec(
  { type: INLINE.mention, propSchema: { kind: { default: "page" }, value: { default: "" }, text: { default: "" } }, content: "none" },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <MentionView kind={inlineContent.props.kind} value={inlineContent.props.value} text={inlineContent.props.text} editable={editor.isEditable}
        onChange={(value) => updateInlineContent({ type: INLINE.mention, props: { kind: inlineContent.props.kind, value, text: inlineContent.props.text } } as never)} />
    ),
  },
);

/**
 * Gleichung im Text: KaTeX über env.renderEquation. Klick (bzw. Enter) öffnet ein Eingabefeld mit Vorschau;
 * Enter oder Verlassen übernimmt, Esc bricht ab. Eine neu eingefügte, leere Gleichung startet im Eingabefeld.
 */
function InlineEquationView(props: { expression: string; editable: boolean; onChange: (expression: string) => void }) {
  const env = useEnv();
  const [editing, setEditing] = useState(props.expression === "" && props.editable);
  const [draft, setDraft] = useState(props.expression);
  const done = useRef(false);
  if (editing && props.editable) {
    const finish = (commit: boolean) => {
      if (done.current) return;
      done.current = true;
      setEditing(false);
      if (commit && draft !== props.expression) props.onChange(draft);
    };
    return (
      <span className="bx-inline-eq is-editing" contentEditable={false}>
        <input className="bx-field bx-inline-eq-field" value={draft} placeholder="x^2" aria-label="Inline equation" autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") finish(false);
            if (e.key === "Enter") {
              e.preventDefault();
              finish(true);
            }
          }}
          onBlur={() => finish(true)} />
        {draft.trim() !== "" && env.renderEquation
          ? <span className="bx-inline-eq-preview" aria-label="Preview">{env.renderEquation({ expression: draft, displayMode: false })}</span>
          : null}
      </span>
    );
  }
  const open = () => {
    if (!props.editable) return;
    done.current = false;
    setDraft(props.expression);
    setEditing(true);
  };
  return (
    <span className="bx-inline-eq" role={props.editable ? "button" : undefined} aria-label={props.editable ? "Edit inline equation" : undefined}
      onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
      {props.expression === ""
        ? <span className="bx-muted">New equation</span>
        : env.renderEquation?.({ expression: props.expression, displayMode: false }) ?? <code className="bx-tex">{props.expression}</code>}
    </span>
  );
}

export const inlineEquation = createReactInlineContentSpec(
  { type: INLINE.equation, propSchema: { expression: { default: "" }, text: { default: "" } }, content: "none" },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <InlineEquationView expression={inlineContent.props.expression} editable={editor.isEditable}
        onChange={(expression) => updateInlineContent({ type: INLINE.equation, props: { expression, text: inlineContent.props.text } } as never)} />
    ),
  },
);
