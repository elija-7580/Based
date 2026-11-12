// BSD-319: „Problem melden“ in der Web-Shell – Editor-Aufzeichnung (läuft immer, Ringpuffer im Speicher), Zustand,
// Layout-Schnappschuss und Bildschirmfoto beim Melden. Entscheidungen und Datenschutz stehen im Kern
// (packages/core/src/bugReport.ts); hier nur, was der Browser liefert.
import {
  buildBugBundle, bundleID, InputRecorder, type BugApp, type BugBundle, type BugEnv, type BugState, type LayoutItem, type Mods, type RecordedEvent,
  type RecordedInput, type SelectionInfo,
} from "@based/core";
import { applyStepsJSON, loadDocJSON, setEditorProbe, setSelectionJSON, type EditorProbeTarget } from "@based/editor";
import { isTauri } from "../desktop.js";
import { diagnosticsLog } from "./diagnostics.js";

/** Ab Build (vite.config.ts): Version der App und Commit. */
export const BUILD = { version: __BASED_VERSION__, commit: __BASED_COMMIT__ };

// MARK: offene Editoren

type EditorView = EditorProbeTarget["view"];

const editors = new Map<string, EditorProbeTarget[]>();
let lastRoot: string | undefined;

const selOf = (view: EditorView): SelectionInfo => {
  const s = view.state.selection as { anchor: number; head: number; constructor: { name: string }; toJSON(): { type?: string } };
  let type = "text";
  try {
    type = s.toJSON().type ?? "text";
  } catch { /* eigene Auswahl-Art */ }
  return { type, anchor: s.anchor, head: s.head };
};

const checkpointOf = (t: EditorProbeTarget) => {
  const doc = t.view.state.doc; // unveränderlich – erst beim Bündeln nach JSON
  return { kind: "checkpoint" as const, root: t.rootID, doc: () => doc.toJSON() as unknown, sel: selOf(t.view) };
};

const current = (root: string) => editors.get(root)?.at(-1);

// MARK: Aufzeichnung

const live = new Set<(e: RecordedEvent) => void>();

export const recorder = new InputRecorder({
  checkpoints: () => [...editors.values()].flatMap((list) => (list.length ? [checkpointOf(list.at(-1)!)] : [])),
});

function record(e: RecordedInput) {
  recorder.record(e);
  if (live.size) {
    const s = recorder.snapshot();
    const last = s.at(-1);
    if (last) for (const l of live) l(last);
  }
}

/** Entwickler-Ansicht: letzte Ereignisse live. */
export const onRecorded = (fn: (e: RecordedEvent) => void) => { live.add(fn); return () => void live.delete(fn); };

/** Kurzbeschreibung eines Elements ohne Inhalt: `div.bn-side-menu[role=menu]#testid`. */
export function describeElement(el: Element | null | undefined): string {
  if (!el) return "none";
  const h = el as HTMLElement;
  const cls = typeof h.className === "string" ? h.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => "." + c).join("") : "";
  const role = el.getAttribute("role");
  const test = el.getAttribute("data-testid");
  const type = el.getAttribute("data-content-type");
  return `${el.tagName.toLowerCase()}${cls}${role ? `[role=${role}]` : ""}${type ? `[${type}]` : ""}${test ? `#${test}` : ""}`;
}

/** Dokument-Wurzel des Editors um ein Element (BlockNoteView trägt `data-root`, der Rahmen `data-page`). */
function rootOf(target: EventTarget | null): string | undefined {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return undefined;
  const r = (el.closest("[data-root]") as HTMLElement | null)?.dataset.root ?? (el.closest(".bx-editor[data-page]") as HTMLElement | null)?.dataset.page;
  return r;
}

const mods = (e: KeyboardEvent | MouseEvent): Mods => ({
  ...(e.metaKey ? { meta: true } : {}), ...(e.ctrlKey ? { ctrl: true } : {}), ...(e.altKey ? { alt: true } : {}), ...(e.shiftKey ? { shift: true } : {}),
});

const describeOrigin = (o: unknown): string => {
  if (o === null || o === undefined) return "local";
  if (typeof o === "string" || typeof o === "number" || typeof o === "symbol") return String(o).slice(0, 40);
  const name = (o as { constructor?: { name?: string } }).constructor?.name;
  const key = (o as { key?: unknown }).key;
  return (typeof key === "string" ? key : name ?? "object").slice(0, 40);
};

const META_KEYS = ["y-sync$", "paste", "uiEvent", "addToHistory", "preventUpdate", "composition", "pointer"];

let installed = false;
let pointerDown = false;
let pointerUpAt = 0;

/** Einmal beim Start (main.tsx): Sonde für Editoren und Ereignisse auf Dokument-Ebene (Erfassungsphase). */
export function installBugRecorder(win: Window & typeof globalThis = globalThis as Window & typeof globalThis) {
  if (installed) return;
  installed = true;
  setEditorProbe((t) => {
    const list = editors.get(t.rootID) ?? [];
    list.push(t);
    editors.set(t.rootID, list);
    record(checkpointOf(t));
    const tiptap = (t.editor as unknown as { _tiptapEditor?: { on(ev: string, fn: (p: { transaction: TransactionLike }) => void): void; off(ev: string, fn: (p: { transaction: TransactionLike }) => void): void } })._tiptapEditor;
    const onTr = ({ transaction: tr }: { transaction: TransactionLike }) => {
      const steps = tr.steps;
      if (!steps.length && !tr.selectionSet) return;
      const meta: string[] = [];
      for (const k of META_KEYS) {
        const v = tr.getMeta(k);
        if (v !== undefined) meta.push(k === "uiEvent" && typeof v === "string" ? `uiEvent:${v}` : k);
      }
      const sel = selOf(t.view);
      // Auswahl per Maus (Klick, Ziehen): ProseMirror setzt sie mit einer reinen Auswahl-Transaktion während oder kurz
      // nach dem Zeigerereignis – die wird als „select“ wiedergegeben.
      if (!tr.docChanged && tr.selectionSet && (pointerDown || Date.now() - pointerUpAt < 400)) record({ kind: "select", root: t.rootID, sel, cause: "pointer" });
      record({ kind: "tr", root: t.rootID, steps: () => steps.map((s) => s.toJSON()), docChanged: tr.docChanged, sel, ...(meta.length ? { meta } : {}) });
    };
    tiptap?.on("transaction", onTr);
    const onY = (update: Uint8Array, origin: unknown) => record({ kind: "yjs", root: t.rootID, bytes: update.byteLength, origin: describeOrigin(origin), update: () => update });
    t.doc.on("update", onY);
    return () => {
      tiptap?.off("transaction", onTr);
      t.doc.off("update", onY);
      const l = editors.get(t.rootID)?.filter((x) => x !== t) ?? [];
      if (l.length) editors.set(t.rootID, l);
      else editors.delete(t.rootID);
    };
  });

  const doc = win.document;
  const opts = { capture: true, passive: true } as const;
  doc.addEventListener("keydown", (e) => {
    const root = rootOf(e.target);
    if (root) lastRoot = root;
    record({ kind: "key", ...(root ? { root } : {}), key: e.key, ...(e.code ? { code: e.code } : {}), mods: mods(e), ...(e.repeat ? { repeat: true } : {}), ...(e.isComposing ? { composing: true } : {}) });
  }, opts);
  doc.addEventListener("beforeinput", (e) => {
    const root = rootOf(e.target);
    record({ kind: "input", ...(root ? { root } : {}), inputType: e.inputType, ...(e.data !== null && e.data !== undefined ? { data: e.data } : {}) });
  }, opts);
  for (const phase of ["start", "update", "end"] as const) {
    doc.addEventListener(`composition${phase}`, (e) => {
      const root = rootOf(e.target);
      record({ kind: "composition", ...(root ? { root } : {}), phase, ...(e.data ? { data: e.data } : {}) });
    }, opts);
  }
  doc.addEventListener("paste", (e) => {
    const root = rootOf(e.target);
    const d = e.clipboardData;
    const plain = d?.getData("text/plain"), html = d?.getData("text/html");
    record({ kind: "paste", ...(root ? { root } : {}), ...(plain ? { plain } : {}), ...(html ? { html } : {}), files: d?.files.length ?? 0 });
  }, opts);
  const pointer = (phase: "down" | "up") => (e: PointerEvent) => {
    pointerDown = phase === "down";
    if (phase === "up") pointerUpAt = Date.now();
    record({ kind: "pointer", phase, x: Math.round(e.clientX), y: Math.round(e.clientY), button: e.button, detail: e.detail, target: describeElement(e.target as Element) });
    const root = rootOf(e.target);
    if (root) lastRoot = root;
  };
  doc.addEventListener("pointerdown", pointer("down"), opts);
  doc.addEventListener("pointerup", pointer("up"), opts);
  doc.addEventListener("focusin", (e) => {
    const root = rootOf(e.target);
    if (root) lastRoot = root;
    record({ kind: "focus", target: describeElement(e.target as Element) });
  }, opts);
}

interface TransactionLike {
  steps: readonly { toJSON(): unknown }[];
  docChanged: boolean;
  selectionSet: boolean;
  getMeta(key: string): unknown;
}

// MARK: Zustand und Layout beim Melden

const FLOATING_HINT = "[role=menu],[role=listbox],[role=dialog],[role=tooltip],.bn-side-menu,.bn-formatting-toolbar,.bn-suggestion-menu,.bx-notice";
const MENU_SELECTOR = "[role=menu],[role=listbox],[role=dialog],.bn-suggestion-menu,.bn-formatting-toolbar";
/** Elemente, die nie in Bericht, Layout oder Foto gehören (der Melde-Dialog selbst). */
export const REPORT_EXCLUDE = "data-report-exclude";

const visible = (r: DOMRect, win: Window) => r.width >= 4 && r.height >= 4 && r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
const rect = (r: DOMRect) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });

function opaque(cs: CSSStyleDeclaration): boolean {
  if (cs.backgroundImage && cs.backgroundImage !== "none") return true;
  const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
  if (!m) return false;
  const parts = m[1]!.split(/[,\s/]+/).filter(Boolean);
  const alpha = parts.length >= 4 ? Number(parts[3]) : 1;
  return alpha >= 0.5 && Number(cs.opacity || "1") >= 0.5;
}

const excluded = (el: Element) => el.closest(`[${REPORT_EXCLUDE}]`) !== null;

/** Rahmen und Ebenen: sichtbare Blöcke, schwebende Flächen, Auswahl, Fokus. Kein Text. */
export function layoutSnapshot(win: Window = globalThis as unknown as Window): LayoutItem[] {
  const doc = win.document;
  const items: LayoutItem[] = [];
  const selected = new Set(current(lastRoot ?? "")?.selectedBlocks() ?? []);
  for (const el of doc.querySelectorAll<HTMLElement>(".bn-block-outer[data-id]")) {
    if (excluded(el)) continue;
    const r = el.getBoundingClientRect();
    if (!visible(r, win)) continue;
    const id = el.dataset.id!;
    const type = el.querySelector("[data-content-type]")?.getAttribute("data-content-type") ?? "block";
    items.push({ kind: "block", label: `${type} #${id}`, rect: rect(r), ...(selected.has(id) ? { selected: true } : {}) });
    if (items.length > 400) break;
  }
  const seen = new Set<Element>();
  const floating = (el: Element, kind: "floating" | "handle") => {
    if (seen.has(el) || excluded(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (!visible(r, win)) return;
    const cs = win.getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return;
    items.push({ kind, label: describeElement(el), rect: rect(r), z: cs.zIndex, position: cs.position, ...(opaque(cs) ? { opaque: true } : {}) });
  };
  for (const el of doc.querySelectorAll(FLOATING_HINT)) floating(el, el.classList.contains("bn-side-menu") ? "handle" : "floating");
  // Alles andere, was mit eigener Ebene schwebt (fixed/absolute mit z-index) – begrenzt, nur beim Melden.
  let scanned = 0;
  for (const el of doc.body.querySelectorAll("*")) {
    if (++scanned > 6000 || items.length > 600) break;
    const cs = win.getComputedStyle(el);
    if ((cs.position === "fixed" || cs.position === "absolute" || cs.position === "sticky") && cs.zIndex !== "auto" && cs.zIndex !== "0") floating(el, "floating");
  }
  const sel = win.getSelection();
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    for (const r of [...sel.getRangeAt(0).getClientRects()].slice(0, 20)) if (visible(r, win)) items.push({ kind: "selection", label: "text selection", rect: rect(r) });
  }
  const active = doc.activeElement;
  if (active && active !== doc.body && !excluded(active)) {
    const r = active.getBoundingClientRect();
    if (visible(r, win)) items.push({ kind: "focus", label: describeElement(active), rect: rect(r) });
  }
  return items;
}

/** Blockbaum (BlockNote): Typen, Verschachtelung, Attribute, Inhalt (wird im Bündel ersetzt). */
function blockTree(t: EditorProbeTarget): unknown {
  const strip = (b: { id: string; type: string; props?: unknown; content?: unknown; children?: unknown[] }): unknown => ({
    id: b.id, type: b.type, props: b.props, content: b.content, children: (b.children ?? []).map((c) => strip(c as typeof b)),
  });
  return (t.editor.document as unknown as Parameters<typeof strip>[0][]).map(strip);
}

export interface FrozenReport {
  at: number;
  events: RecordedEvent[];
  state: BugState;
  layout: LayoutItem[];
  env: BugEnv;
  app: BugApp;
  log: ReturnType<typeof diagnosticsLog.getSnapshot>;
}

/** Den Zustand jetzt einfrieren (synchron, bevor der Dialog etwas verändert). */
export function freezeReport(win: Window = globalThis as unknown as Window): FrozenReport {
  const doc = win.document;
  const activeRoot = rootOf(doc.activeElement);
  const root = activeRoot ?? lastRoot ?? [...editors.keys()].at(-1);
  const t = root ? current(root) : undefined;
  const state: BugState = { menus: [...doc.querySelectorAll(MENU_SELECTOR)].filter((m) => !excluded(m) && m.getBoundingClientRect().width > 0).map((m) => describeElement(m)) };
  if (t) {
    state.root = t.rootID;
    try {
      state.doc = t.view.state.doc.toJSON();
      state.blocks = blockTree(t);
    } catch { /* Editor gerade weg */ }
    state.sel = selOf(t.view);
  }
  state.focus = describeElement(doc.activeElement);
  const route = (/^#([a-z-]+)/.exec(win.location.hash)?.[1]) ?? "home";
  const env: BugEnv = {
    width: win.innerWidth, height: win.innerHeight, dpr: win.devicePixelRatio || 1, zoom: win.visualViewport?.scale ?? 1,
    theme: doc.documentElement.dataset.theme ?? "light", ...(doc.documentElement.dataset.style ? { style: doc.documentElement.dataset.style } : {}), route,
  };
  const app: BugApp = {
    shell: isTauri() ? "desktop" : "web", ...(BUILD.version ? { version: BUILD.version } : {}), ...(BUILD.commit ? { commit: BUILD.commit } : {}),
    platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform, userAgent: navigator.userAgent,
  };
  // erst nach dem Zustand: das Layout liest Rahmen (kann einen Layout-Durchlauf auslösen, ändert aber nichts)
  return { at: Date.now(), events: recorder.snapshot(), state, layout: layoutSnapshot(win), env, app, log: diagnosticsLog.getSnapshot() };
}

/** Bildschirmfoto des Fensters (DOM gerastert; der Melde-Dialog bleibt draußen). Scheitert still → undefined. */
export async function captureScreenshot(win: Window = globalThis as unknown as Window): Promise<Blob | undefined> {
  try {
    const { toBlob } = await import("html-to-image");
    const node = win.document.body;
    const blob = await toBlob(node, {
      width: win.innerWidth, height: win.innerHeight, pixelRatio: Math.min(2, win.devicePixelRatio || 1), cacheBust: false,
      filter: (n) => !(n instanceof Element && n.hasAttribute(REPORT_EXCLUDE)),
      backgroundColor: win.getComputedStyle(win.document.body).backgroundColor || undefined,
    });
    return blob ?? undefined;
  } catch (e) {
    diagnosticsLog.add("warning", `report screenshot failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Aus eingefrorenem Zustand, Satz und Wahl das Bündel bauen (Datenschutz im Kern). */
export function makeBundle(f: FrozenReport, note: string, opts: { realText: boolean; screenshot: boolean }): BugBundle {
  return buildBugBundle({
    id: bundleID(f.at), now: f.at, note, realText: opts.realText, ...(opts.screenshot ? { screenshot: "screenshot.png" } : {}),
    app: f.app, env: f.env, state: f.state, layout: f.layout, events: f.events, log: f.log,
  });
}

// MARK: Haken für Tests und Wiedergabe

export interface ReplayHooks {
  /** Editor der Wurzel: Dokument (JSON) und Auswahl setzen bzw. lesen. */
  load(root: string, doc: unknown, sel: SelectionInfo): boolean;
  setSelection(root: string, sel: SelectionInfo): boolean;
  applySteps(root: string, steps: unknown[]): boolean;
  docJSON(root: string): unknown;
  roots(): string[];
  freeze(): FrozenReport;
  bundle(note: string, realText?: boolean): BugBundle;
  /** Aufzeichnung an/aus (Messung im Perf-Test). */
  recording(on: boolean): void;
}

/** `globalThis.__basedReport` – Wiedergabe in apps/web/e2e/replay/ und Tests. */
export function exposeReplayHooks() {
  const view = (root: string) => current(root)?.view;
  const run = (root: string, fn: (v: EditorView) => void) => {
    const v = view(root);
    if (!v) return false;
    fn(v);
    return true;
  };
  const hooks: ReplayHooks = {
    load: (root, json, sel) => run(root, (v) => loadDocJSON(v, json, sel)),
    setSelection: (root, sel) => run(root, (v) => setSelectionJSON(v, sel)),
    applySteps: (root, steps) => run(root, (v) => applyStepsJSON(v, steps)),
    docJSON: (root) => view(root)?.state.doc.toJSON(),
    roots: () => [...editors.keys()],
    freeze: () => freezeReport(),
    bundle: (note, realText = false) => makeBundle(freezeReport(), note, { realText, screenshot: false }),
    recording: (on) => { recorder.on = on; },
  };
  (globalThis as { __basedReport?: ReplayHooks }).__basedReport = hooks;
}
