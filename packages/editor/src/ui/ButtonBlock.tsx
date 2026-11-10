// BSD-210: Button-Block wie Notion – Klick führt die Schritte aus (runButton in @based/core, Swift ButtonOps), „Edit“
// öffnet darunter die Einrichtung: Beschriftung, Schritte („When clicked“), bei „Insert blocks“ die Vorlage als
// eingebetteter Editor (die Kinder des Buttons, ein eigenes Dokument wie beim Synced Block).
import {
  BUTTON_ACTION_KINDS, buttonActionName, buttonLabel, effectiveButtonActions, isKnownButtonAction, plainText, runButton, setButton,
  type ButtonAction, type ButtonEffect, type ButtonPause,
} from "@based/core";
import { useState } from "react";
import { useEnv, usePageRef, useStoreRevision, type EditorEnv } from "./env.js";
import { DatabasePicker, PageTargetPicker } from "./MovePicker.js";

/** Buttons, die gerade per Slash-Menü entstanden sind: die Einrichtung geht gleich auf. */
export const freshButtons = new Set<string>();

/** Was der Block vom Editor braucht, um nach „Insert blocks“ die Schreibmarke zu setzen. */
export interface CaretEditor {
  setTextCursorPosition(id: string, placement: "start" | "end"): void;
  focus(): void;
}

export function ButtonBlockView(props: { id: string; editor: CaretEditor }) {
  const env = useEnv();
  useStoreRevision(env.store);
  const rec = env.store.blocks.get(props.id);
  const [editing, setEditing] = useState(() => env.editable && freshButtons.delete(props.id));
  const [pause, setPause] = useState<ButtonPause | undefined>();
  const [busy, setBusy] = useState(false);
  const label = buttonLabel(rec);

  const run = async (from = 0, added: Record<number, string> = {}) => {
    setPause(undefined);
    env.flush();
    setBusy(true);
    try {
      // Seiten-Repliken kennen fremde Datenbanken nicht: Ziele von „Add page to“ erst holen.
      for (const a of effectiveButtonActions(env.store.blocks.get(props.id)?.props).slice(from)) {
        if (a.kind === "addPage" && a.targetID && !env.store.databases.has(a.targetID)) {
          try {
            await env.databases.include?.(a.targetID);
          } catch { /* unten als „needs setup“ */ }
        }
      }
      const r = runButton(env.store, props.id, { from, added, pageExists: (id) => pageExists(env, id) });
      applyEffects(r.effects);
      if (r.pause) setPause(r.pause);
    } finally {
      setBusy(false);
    }
  };

  const applyEffects = (effects: ButtonEffect[]) => {
    for (const e of effects) {
      switch (e.kind) {
        case "needsSetup":
          if (env.editable) setEditing(true);
          env.notify("This button needs setting up.");
          break;
        case "open":
          env.onOpenPage?.(e.id);
          break;
        case "openURL":
          globalThis.open?.(/^[a-z][a-z0-9+.-]*:/i.test(e.url) ? e.url : "https://" + e.url, "_blank", "noopener,noreferrer");
          break;
        case "focusEnd":
          focusWhenThere(props.editor, e.id);
          break;
      }
    }
  };

  return (
    <div className="bx-btn" data-editing={editing ? "true" : undefined}>
      <div className="bx-btn-row">
        <button type="button" className="bx-button bx-btn-run" disabled={!env.editable || busy} onClick={() => void run()}
          title={env.editable ? undefined : "Buttons run when the page can be edited"}>{label}</button>
        {env.editable ? (
          <button type="button" className="bx-btn-edit" aria-expanded={editing} aria-label="Edit button" onClick={() => setEditing((o) => !o)}>
            {editing ? "Done" : "Edit"}
          </button>
        ) : null}
      </div>
      {pause ? (
        <div className="bx-btn-confirm" role="alertdialog" aria-label="Confirm">
          <span>{pause.message}</span>
          <button type="button" className="bx-btn-edit" onClick={() => setPause(undefined)}>Cancel</button>
          <button type="button" className="bx-button" autoFocus onClick={() => void run(pause.next, pause.added)}>Continue</button>
        </div>
      ) : null}
      {editing ? <ButtonSetup id={props.id} onDone={() => setEditing(false)} /> : null}
    </div>
  );
}

function pageExists(env: EditorEnv, id: string): boolean {
  if (env.store.blocks.has(id)) return true;
  const ref = env.pages.get(id);
  return !(ref?.missing || ref?.trashed);
}

/** Die eingefügten Blöcke kommen über den Store ins Dokument; kurz warten, bis der letzte dort ist. */
function focusWhenThere(editor: CaretEditor, id: string, tries = 10) {
  const attempt = (n: number) => {
    try {
      editor.setTextCursorPosition(id, "end");
      editor.focus();
    } catch {
      if (n > 0) setTimeout(() => attempt(n - 1), 50);
    }
  };
  setTimeout(() => attempt(tries), 0);
}

function ButtonSetup(props: { id: string; onDone: () => void }) {
  const env = useEnv();
  const rec = env.store.blocks.get(props.id);
  const [label, setLabel] = useState(rec?.props?.buttonLabel ?? "");
  const steps = effectiveButtonActions(rec?.props);
  const [picking, setPicking] = useState<{ step: number; kind: "database" | "page" } | undefined>();
  const [dbTitles, setDbTitles] = useState<Record<string, string>>({});

  const save = (actions: ButtonAction[]) => {
    env.flush();
    setButton(env.store, props.id, { actions });
  };
  const change = (i: number, patch: Partial<ButtonAction>) => {
    const next = steps.map((s, n) => {
      if (n !== i) return s;
      const out = { ...s, ...patch } as ButtonAction;
      for (const [k, v] of Object.entries(patch)) if (v === undefined || v === "") delete (out as Record<string, unknown>)[k];
      return out;
    });
    save(next);
  };
  const setKind = (i: number, kind: string) => {
    const next = steps.map((s, n) => (n === i ? ({ kind } as ButtonAction) : s));
    save(next);
  };
  const addSteps = steps.flatMap((s, n) => (s.kind === "addPage" ? [n] : []));
  const hasTemplate = steps.some((s) => s.kind === "insertBlocks");

  return (
    <div className="bx-btn-setup" role="group" aria-label="Button settings" onKeyDown={(e) => e.stopPropagation()}>
      <label className="bx-btn-field">
        <span className="bx-btn-caption">Button name</span>
        <input className="bx-field" value={label} placeholder="Button" aria-label="Button name"
          onChange={(e) => {
            setLabel(e.target.value);
            env.flush();
            setButton(env.store, props.id, { label: e.target.value }, "button-label:" + props.id);
          }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") props.onDone(); }} />
      </label>
      <span className="bx-btn-caption">When clicked</span>
      <ol className="bx-btn-steps">
        {steps.map((s, i) => (
          <li key={i} className="bx-btn-step" data-kind={s.kind}>
            {isKnownButtonAction(s.kind) ? (
              <select className="bx-field bx-btn-kind" aria-label={`Step ${i + 1}`} value={s.kind} onChange={(e) => setKind(i, e.target.value)}>
                {BUTTON_ACTION_KINDS.map((k) => <option key={k} value={k}>{buttonActionName(k)}</option>)}
              </select>
            ) : <span className="bx-muted">{buttonActionName(s.kind)} ({s.kind})</span>}
            {s.kind === "addPage" ? (
              <>
                <button type="button" className="bx-btn-target" onClick={() => setPicking({ step: i, kind: "database" })}>
                  {s.targetID ? databaseTitle(env, s.targetID, dbTitles) : "Choose a database…"}
                </button>
                <input className="bx-field" aria-label="Page name" placeholder="Page name" defaultValue={s.title ?? ""}
                  onBlur={(e) => { if ((s.title ?? "") !== e.target.value) change(i, { title: e.target.value }); }} />
              </>
            ) : null}
            {s.kind === "openPage" ? (
              <>
                <button type="button" className="bx-btn-target" onClick={() => setPicking({ step: i, kind: "page" })}>
                  {s.targetID ? <PageName id={s.targetID} /> : "Choose a page…"}
                </button>
              </>
            ) : null}
            {s.kind === "openAdded" ? (
              <>
                <select className="bx-field" aria-label="Which page" value={s.step === undefined ? "" : String(s.step)}
                  onChange={(e) => change(i, { step: e.target.value === "" ? undefined : Number(e.target.value) })}>
                  <option value="">Last added page</option>
                  {addSteps.filter((n) => n < i).map((n) => <option key={n} value={String(n)}>Page from step {n + 1}</option>)}
                </select>
              </>
            ) : null}
            {s.kind === "openURL" ? (
              <input className="bx-field" aria-label="Link" placeholder="https://…" defaultValue={s.url ?? ""}
                onBlur={(e) => { if ((s.url ?? "") !== e.target.value.trim()) change(i, { url: e.target.value.trim() }); }} />
            ) : null}
            {s.kind === "confirm" ? (
              <input className="bx-field" aria-label="Message" placeholder="Are you sure?" defaultValue={s.message ?? ""}
                onBlur={(e) => { if ((s.message ?? "") !== e.target.value) change(i, { message: e.target.value }); }} />
            ) : null}
            {s.kind === "insertBlocks" ? <span className="bx-muted">Inserts the blocks below after the button.</span> : null}
            <button type="button" className="bx-btn-remove" aria-label={`Remove step ${i + 1}`} onClick={() => save(steps.filter((_, n) => n !== i))}>×</button>
          </li>
        ))}
      </ol>
      <div className="bx-btn-actions">
        <select className="bx-field bx-btn-add" aria-label="Add step" value="" onChange={(e) => { if (e.target.value) save([...steps, { kind: e.target.value } as ButtonAction]); }}>
          <option value="">+ Add step</option>
          {BUTTON_ACTION_KINDS.map((k) => <option key={k} value={k}>{buttonActionName(k)}</option>)}
        </select>
        <button type="button" className="bx-button" onClick={props.onDone}>Done</button>
      </div>
      {hasTemplate ? (
        <div className="bx-btn-template" aria-label="Blocks to insert">
          <span className="bx-btn-caption">Blocks to insert</span>
          {env.renderSynced(props.id)}
        </div>
      ) : null}
      {picking?.kind === "database" ? (
        <DatabasePicker source={env.databases} onClose={() => setPicking(undefined)} onPick={(db) => {
          setDbTitles((t) => ({ ...t, [db.id]: db.title }));
          change(picking.step, { targetID: db.id });
          setPicking(undefined);
        }} />
      ) : null}
      {picking?.kind === "page" ? (
        <PageTargetPicker pages={env.pages} onClose={() => setPicking(undefined)} onPick={(p) => {
          change(picking.step, { targetID: p.id });
          setPicking(undefined);
        }} />
      ) : null}
    </div>
  );
}

function databaseTitle(env: EditorEnv, id: string, picked: Record<string, string>): string {
  const db = env.store.databases.get(id);
  return db ? plainText(db.title) || "Untitled" : picked[id] ?? "Database";
}

function PageName(props: { id: string }) {
  const env = useEnv();
  const ref = usePageRef(env.pages, props.id);
  if (ref?.missing) return <>Page not found</>;
  return <>{ref?.title || "Untitled"}</>;
}
