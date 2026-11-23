// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// „Write anywhere“ (Mac-App): ein Tastenkürzel in jedem Programm öffnet ein kleines Based-Fenster. Die Hülle
// (apps/desktop/src-tauri/src/anywhere.rs) liest dabei – nur in diesem Moment – das Feld mit dem Cursor; das
// Hauptfenster schreibt mit dem Chat-Modell und dem, was das Gedächtnis über den Nutzer weiß, und die Hülle fügt
// das Ergebnis dort ein. Hier: was an das Modell geht (rein, getestet) und der Dienst im Hauptfenster.
// Opt-in: Einstellungen → Agents & AI → „Write anywhere on this Mac“.
import { isTauri } from "../desktop.js";

export const ANYWHERE_LABEL = "anywhere";
/** Fest, bis es eine Auswahl gibt: kollidiert weder mit Spotlight (⌘Space) noch mit ⌥Space anderer Assistenten. */
export const ANYWHERE_SHORTCUT = "Control+Alt+Space";
export const ANYWHERE_ASK = "anywhere://ask";
export const ANYWHERE_ANSWER = "anywhere://answer";
export const ANYWHERE_CANCEL = "anywhere://cancel";
export const ANYWHERE_OPEN = "anywhere://open";

/** Läuft diese Seite als das kleine Fenster? Dann rendert main.tsx nur AnywherePanel. */
export function isAnywhereWindow(search: string = globalThis.location?.search ?? ""): boolean {
  return new URLSearchParams(search).get("window") === ANYWHERE_LABEL;
}

/** Was die Hülle beim Tastendruck gelesen hat (AnywhereContext in anywhere.rs). */
export interface AnywhereContext {
  app: string;
  title: string;
  text: string;
  selection: string;
  secure: boolean;
}

export const EMPTY_CONTEXT: AnywhereContext = { app: "", title: "", text: "", selection: "", secure: false };

export interface AnywhereAsk { id: string; instruction: string; context: AnywhereContext }
export interface AnywhereAnswer { id: string; text?: string; error?: string }

/** Schnellwahl im Fenster; welche passt, hängt davon ab, was gelesen wurde. */
export const ANYWHERE_ACTIONS = [
  { id: "reply", label: "Reply", needs: "text", prompt: "Write my reply to the message in the field. Only the reply." },
  { id: "continue", label: "Continue", needs: "text", prompt: "Continue the text in the field from where it ends. Only the continuation." },
  { id: "improve", label: "Improve", needs: "selection", prompt: "Improve the writing of the selected text. Keep its meaning and language." },
  { id: "shorter", label: "Shorter", needs: "selection", prompt: "Make the selected text shorter. Keep the key points." },
] as const;

export function actionsFor(ctx: AnywhereContext): (typeof ANYWHERE_ACTIONS)[number][] {
  return ANYWHERE_ACTIONS.filter((a) => (a.needs === "selection" ? ctx.selection.trim() !== "" : ctx.text.trim() !== "" && ctx.selection.trim() === ""));
}

export const ANYWHERE_SYSTEM = "You write for the user inside another app on their Mac; your answer is pasted at their cursor. Reply only with the text to insert, as plain text without Markdown, in the language of the field or selection. No preamble, no closing remarks, no quotation marks around the answer.";

/** Was an das Modell geht: Anweisung, Programm und – als begrenzter Kontext – Markierung oder Feldtext. */
export function anywherePrompt(instruction: string, ctx: AnywhereContext): string {
  const parts = [`Instruction: ${instruction.trim()}`];
  const where = [ctx.app.trim(), ctx.title.trim()].filter(Boolean).join(" – ");
  if (where) parts.push(`App: ${where}`);
  if (ctx.selection.trim()) parts.push(`Selected text (your answer replaces it):\n${ctx.selection.trim()}`);
  else if (ctx.text.trim()) parts.push(`Text in the field so far (context only, do not repeat it):\n${ctx.text.trim()}`);
  return parts.join("\n\n");
}

/** Wonach im Gedächtnis gesucht wird. */
export const anywhereQuery = (instruction: string, ctx: AnywhereContext): string =>
  [instruction, ctx.app, ctx.title, (ctx.selection || ctx.text).slice(-1200)].join("\n");

export interface AnywhereService {
  enabled: () => boolean;
  subscribe: (fn: () => void) => () => void;
  /** Ein Aufruf des Chat-Modells ohne Werkzeuge; wirft, wenn keines eingerichtet ist. */
  write: (system: string, prompt: string, signal: AbortSignal) => Promise<string>;
  /** About me, Schreibstil, passende Memories – leer, wenn es nichts gibt. */
  personal: (query: string) => Promise<string>;
  /** Vor dem Senden schwärzen und in der Antwort zurücktauschen (Privacy-Redact an), sonst unverändert. */
  redact?: () => Promise<{ out: (s: string) => string; back: (s: string) => string } | undefined>;
}

/** Eine Anfrage des kleinen Fensters beantworten (rein bis auf `service`; getestet). */
export async function answerAnywhere(ask: AnywhereAsk, service: AnywhereService, signal: AbortSignal): Promise<AnywhereAnswer> {
  if (!ask.instruction.trim()) return { id: ask.id, error: "Tell Based what to write." };
  try {
    const personal = await service.personal(anywhereQuery(ask.instruction, ask.context)).catch(() => "");
    const r = await service.redact?.().catch(() => undefined);
    const system = personal.trim() ? `${ANYWHERE_SYSTEM}\n\n${personal.trim()}` : ANYWHERE_SYSTEM;
    const prompt = anywherePrompt(ask.instruction, ask.context);
    const text = (await service.write(system, r ? r.out(prompt) : prompt, signal)).trim();
    if (!text) return { id: ask.id, error: "The model returned nothing. Try again." };
    return { id: ask.id, text: r ? r.back(text) : text };
  } catch (e) {
    if (signal.aborted) return { id: ask.id, error: "Stopped." };
    return { id: ask.id, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Nur im Hauptfenster der Mac-App: Tastenkürzel nach der Einstellung an-/abmelden, Anfragen beantworten. */
export function startAnywhere(service: AnywhereService): () => void {
  if (!isTauri()) return () => undefined;
  let stopped = false;
  const running = new Map<string, AbortController>();
  const unlisten: (() => void)[] = [];
  const sync = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("anywhere_enable", { shortcut: service.enabled() && !stopped ? ANYWHERE_SHORTCUT : null });
    } catch {
      // ältere Hülle ohne den Befehl: dann gibt es das Kürzel nicht
    }
  };
  void (async () => {
    try {
      const { listen, emitTo } = await import("@tauri-apps/api/event");
      unlisten.push(await listen<AnywhereAsk>(ANYWHERE_ASK, (e) => {
        const abort = new AbortController();
        running.set(e.payload.id, abort);
        void answerAnywhere(e.payload, service, abort.signal).then((a) => {
          running.delete(a.id);
          return emitTo(ANYWHERE_LABEL, ANYWHERE_ANSWER, a);
        }).catch(() => undefined);
      }));
      unlisten.push(await listen<string>(ANYWHERE_CANCEL, (e) => running.get(e.payload)?.abort()));
      if (stopped) unlisten.splice(0).forEach((f) => f());
    } catch {
      // ohne Ereignisse: kein Dienst
    }
  })();
  const off = service.subscribe(() => void sync());
  void sync();
  return () => {
    stopped = true;
    off();
    unlisten.splice(0).forEach((f) => f());
    for (const a of running.values()) a.abort();
    void sync();
  };
}
