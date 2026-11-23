// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Inhalt des kleinen Fensters von „Write anywhere“ (Mac-App, anywhere.ts): sagen, was geschrieben werden soll (oder
// eine Schnellwahl), Ergebnis ansehen, einfügen. Sieht aus wie ein Hinweis (elements.md, Abschnitt 4). Geschrieben
// wird im Hauptfenster (dort liegen Modell und Gedächtnis); dieses Fenster kennt weder Speicher noch Schlüssel.
import { BasedButton, BasedField, BasedKeys } from "@based/ui/astryx";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  actionsFor, ANYWHERE_ANSWER, ANYWHERE_ASK, ANYWHERE_CANCEL, ANYWHERE_OPEN, EMPTY_CONTEXT, type AnywhereAnswer, type AnywhereAsk, type AnywhereContext,
} from "./anywhere.js";
import "./anywhere.css";

type Phase = { name: "ask" } | { name: "writing"; id: string } | { name: "result"; text: string } | { name: "error"; message: string };

/** Was die Hülle anbietet; in Tests ersetzt. */
export interface AnywhereBridge {
  context(): Promise<AnywhereContext>;
  ask(a: AnywhereAsk): Promise<void>;
  cancel(id: string): Promise<void>;
  insert(text: string): Promise<boolean>;
  copy(text: string): Promise<void>;
  hide(): Promise<void>;
  onOpen(fn: () => void): Promise<() => void>;
  onAnswer(fn: (a: AnywhereAnswer) => void): Promise<() => void>;
}

export const tauriBridge: AnywhereBridge = {
  context: async () => (await import("@tauri-apps/api/core")).invoke<AnywhereContext>("anywhere_context"),
  ask: async (a) => (await import("@tauri-apps/api/event")).emitTo("main", ANYWHERE_ASK, a),
  cancel: async (id) => (await import("@tauri-apps/api/event")).emitTo("main", ANYWHERE_CANCEL, id),
  insert: async (text) => (await import("@tauri-apps/api/core")).invoke<boolean>("anywhere_insert", { text }),
  copy: async (text) => (await import("@tauri-apps/plugin-clipboard-manager")).writeText(text),
  hide: async () => (await import("@tauri-apps/api/window")).getCurrentWindow().hide(),
  onOpen: async (fn) => (await import("@tauri-apps/api/event")).listen(ANYWHERE_OPEN, () => fn()),
  onAnswer: async (fn) => (await import("@tauri-apps/api/event")).listen<AnywhereAnswer>(ANYWHERE_ANSWER, (e) => fn(e.payload)),
};

export function AnywherePanel({ bridge = tauriBridge }: { bridge?: AnywhereBridge }) {
  const [ctx, setCtx] = useState<AnywhereContext>(EMPTY_CONTEXT);
  const [instruction, setInstruction] = useState("");
  const [phase, setPhase] = useState<Phase>({ name: "ask" });
  const input = useRef<HTMLInputElement>(null);
  const current = useRef<string | undefined>(undefined);
  const last = useRef("");

  const reset = useCallback(() => {
    current.current = undefined;
    setInstruction("");
    setPhase({ name: "ask" });
    void bridge.context().then(setCtx, () => setCtx(EMPTY_CONTEXT));
    requestAnimationFrame(() => input.current?.focus());
  }, [bridge]);

  useEffect(() => {
    reset();
    const off: (() => void)[] = [];
    let gone = false;
    const keep = (f: () => void) => { if (gone) f(); else off.push(f); };
    void bridge.onOpen(reset).then(keep, () => undefined);
    void bridge.onAnswer((a) => {
      if (a.id !== current.current) return;
      current.current = undefined;
      setPhase(a.text ? { name: "result", text: a.text } : { name: "error", message: a.error ?? "Something went wrong." });
    }).then(keep, () => undefined);
    return () => {
      gone = true;
      off.forEach((f) => f());
    };
  }, [bridge, reset]);

  const send = useCallback((text: string) => {
    if (!text.trim()) return;
    const id = crypto.randomUUID();
    current.current = id;
    last.current = text;
    setPhase({ name: "writing", id });
    void bridge.ask({ id, instruction: text, context: ctx }).catch(() => setPhase({ name: "error", message: "Based's main window isn't running." }));
  }, [bridge, ctx]);

  const stop = useCallback(() => {
    if (current.current) void bridge.cancel(current.current);
    current.current = undefined;
    setPhase({ name: "ask" });
  }, [bridge]);

  const insert = useCallback((text: string) => {
    void bridge.insert(text).then((ok) => { if (!ok) setPhase({ name: "error", message: "Couldn't paste into the app. The text is still here: use Copy." }); }, () => undefined);
  }, [bridge]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (phase.name === "writing") stop();
        else void bridge.hide();
      } else if (e.key === "Enter" && phase.name === "result") {
        e.preventDefault();
        insert(phase.text);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [bridge, phase, stop, insert]);

  const where = [ctx.app, ctx.title].filter(Boolean).join(" · ");
  const quick = actionsFor(ctx);
  return (
    <section className="anywhere" aria-label="Write with Based" data-testid="anywhere-panel" data-phase={phase.name}>
      <header className="anywhere-head">
        <span className="anywhere-title">Write with Based</span>
        {where ? <span className="anywhere-where" title={where}>{where}</span> : null}
      </header>
      {phase.name === "result" ? (
        <>
          <pre className="anywhere-result" data-testid="anywhere-result">{phase.text}</pre>
          <footer className="anywhere-actions">
            <BasedButton label="Try again" variant="ghost" onClick={() => send(last.current)} />
            <span className="anywhere-actions-end">
              <BasedButton label="Copy" variant="secondary" onClick={() => void bridge.copy(phase.text).then(() => bridge.hide())} />
              <BasedButton label={ctx.app ? `Insert into ${ctx.app}` : "Insert"} variant="primary" onClick={() => insert(phase.text)} />
            </span>
          </footer>
        </>
      ) : (
        <>
          <BasedField label="What should Based write?" labelHidden placeholder={ctx.selection ? "What should happen to the selected text?" : "What should Based write?"}
            value={instruction} onChange={setInstruction} onEnter={() => send(instruction)} disabled={phase.name === "writing"} inputRef={input} autoFocus />
          {phase.name === "error" ? <p className="anywhere-note" role="alert">{phase.message}</p> : null}
          {phase.name === "writing" ? (
            <footer className="anywhere-actions">
              <p className="anywhere-note" role="status">Writing…</p>
              <span className="anywhere-actions-end"><BasedButton label="Stop" variant="ghost" onClick={stop} /></span>
            </footer>
          ) : (
            <footer className="anywhere-actions">
              {quick.map((a) => <BasedButton key={a.id} label={a.label} variant="secondary" onClick={() => send(a.prompt)} />)}
              {quick.length === 0 ? <p className="anywhere-note">{ctx.secure ? "Password field: Based read nothing." : "Based couldn't read this field. It still writes from your instruction."}</p> : null}
              <span className="anywhere-actions-end"><BasedKeys keys="Esc" /></span>
            </footer>
          )}
        </>
      )}
    </section>
  );
}
