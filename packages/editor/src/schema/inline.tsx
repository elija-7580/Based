// BSD-154: Erwähnungen (Seite, Person, Datum, Link) und Gleichungen im Text.
import { createReactInlineContentSpec } from "@blocknote/react";
import { useRef, useState } from "react";
import { dateFromSwift } from "@based/core";
import { INLINE } from "../mapping/bn.js";
import { useEnv, useStoreRevision } from "../ui/env.js";
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

function MentionView(props: { kind: string; value: string; text: string }) {
  const env = useEnv();
  useStoreRevision(env.store);
  switch (props.kind) {
    case "page": {
      const rec = env.store.blocks.get(props.value);
      const open = () => {
        env.flush();
        env.onOpenPage?.(props.value);
      };
      return (
        <span className="bx-mention" data-kind="page" role="link" tabIndex={-1} onClick={open}>
          <span aria-hidden>{rec ? pageIcon(rec) : "📄"}</span>{rec ? pageTitle(rec) : props.text || "Unknown page"}
        </span>
      );
    }
    case "user": {
      const name = env.people?.find((p) => p.id === props.value)?.name ?? props.text ?? props.value;
      return <span className="bx-mention" data-kind="user">@{name}</span>;
    }
    case "date":
      return <span className="bx-mention" data-kind="date">@{formatDate(props.value)}</span>;
    default:
      return <a className="bx-mention" data-kind="link" href={props.value} target="_blank" rel="noreferrer">{props.text || props.value}</a>;
  }
}

export const mentionInline = createReactInlineContentSpec(
  { type: INLINE.mention, propSchema: { kind: { default: "page" }, value: { default: "" }, text: { default: "" } }, content: "none" },
  { render: ({ inlineContent }) => <MentionView kind={inlineContent.props.kind} value={inlineContent.props.value} text={inlineContent.props.text} /> },
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
