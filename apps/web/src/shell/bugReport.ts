// BSD-319: „Problem melden“ in der Web-Shell – Editor-Aufzeichnung (läuft immer, Ringpuffer im Speicher), Zustand,
// Layout-Schnappschuss und Bildschirmfoto beim Melden. Entscheidungen und Datenschutz stehen im Kern
// (packages/core/src/bugReport.ts); hier nur, was der Browser liefert.
import {
  applyBlockChanges, blockDoc, blockDocOf, blockPath, isBlockDoc, loadBlockDoc, observePageChanges, pageBlocks, resolveReplaySelection, type ReplayIDs,
  buildBugBundle, bundleID, InputRecorder, type BugApp, type BugBundle, type BugEnv, type BugState, type LayoutItem, type Mods, type RecordedEvent,
  type HangReport, type RecordedInput, type SelectionInfo,
} from "@based/core";
import { setBlockEditorProbe, type BlockEditorProbeTarget } from "@based/editor";
import { isTauri } from "../desktop.js";
import { diagnosticsLog } from "./diagnostics.js";
import { hangBundle } from "./hangs.js";

/** Ab Build (vite.config.ts): Version der App und Commit. */
export const BUILD = { version: __BASED_VERSION__, commit: __BASED_COMMIT__ };

// MARK: offene Editoren

// BSD-407 Teil 4: nur noch der Block-Editor; die ProseMirror-Sonde des alten Editors ist entfernt. Aufzeichnungen
// mit „tr“/„yjs“-Ereignissen aus älteren Versionen bleiben im Kern lesbar (Typen), lassen sich aber nicht mehr abspielen.
let lastRoot: string | undefined;

// Block-Editor (ADR 0016): je Seite die offenen Editoren; Transaktionen der Seite hört die Shell einmal je Seite ab.
const blockEditors = new Map<string, BlockEditorProbeTarget[]>();
const currentBlock = (root: string) => blockEditors.get(root)?.at(-1);

/**
 * Transaktionen einer Seite: einmal je Seite abhören (zwei Fenster derselben Seite melden jede Transaktion einmal),
 * am Store des zuletzt geöffneten Editors; nach dem Schließen des letzten Editors nicht mehr.
 */
const pageListeners = new Map<string, { store: BlockEditorProbeTarget["store"]; off: () => void }>();
function listenToPage(root: string) {
  const t = currentBlock(root);
  const cur = pageListeners.get(root);
  if (cur && cur.store === t?.store) return;
  cur?.off();
  pageListeners.delete(root);
  if (t) pageListeners.set(root, { store: t.store, off: observePageChanges(t.store, root, (c) => record({ kind: "change", root, ...c })) });
}

/** Auswahl im Block-Editor samt Stelle des Blocks im Baum (für die Wiedergabe). */
const blockSel = (t: BlockEditorProbeTarget): SelectionInfo => {
  const sel: SelectionInfo = t.selection();
  const path = sel.block ? blockPath(t.store, t.rootID, sel.block) : undefined;
  return path ? { ...sel, path } : sel;
};

// Review 18.11.: `doc` darf den Editor (`t`) nicht einschließen – sonst hält jeder Zwischenstand im Ringpuffer den
// geschlossenen Editor samt DOM fest (300-Block-Seite: ~4 800 Knoten, ~0,75 MB je Öffnen, bis zu 2 min/500 Ereignisse).
// Darum eine eigene Funktion, deren Scope nur Records, Wurzel-ID und Auswahl kennt (e2e/editor-leak.spec.ts).
const checkpointOf = (refs: ReturnType<typeof pageBlocks>, root: string, sel: SelectionInfo) =>
  ({ kind: "checkpoint" as const, root, doc: () => blockDoc(refs, root) as unknown, sel });
// Verweise auf unveränderliche Records – der Baum erst beim Bündeln
const blockCheckpointOf = (t: BlockEditorProbeTarget) => checkpointOf(pageBlocks(t.store, t.rootID), t.rootID, blockSel(t));

// MARK: Aufzeichnung

const live = new Set<(e: RecordedEvent) => void>();

export const recorder = new InputRecorder({
  checkpoints: () => [
    ...[...blockEditors.values()].flatMap((list) => (list.length ? [blockCheckpointOf(list.at(-1)!)] : [])),
  ],
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

/** Kurzbeschreibung eines Elements ohne Inhalt: `div.bx2-menu[role=menu]#testid`. */
export function describeElement(el: Element | null | undefined): string {
  if (!el) return "none";
  const h = el as HTMLElement;
  const cls = typeof h.className === "string" ? h.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((c) => "." + c).join("") : "";
  const role = el.getAttribute("role");
  const test = el.getAttribute("data-testid");
  const type = el.getAttribute("data-content-type");
  return `${el.tagName.toLowerCase()}${cls}${role ? `[role=${role}]` : ""}${type ? `[${type}]` : ""}${test ? `#${test}` : ""}`;
}

/** Dokument-Wurzel des Editors um ein Element (der Block-Editor trägt `data-root`). */
function rootOf(target: EventTarget | null): string | undefined {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return undefined;
  return (el.closest("[data-root]") as HTMLElement | null)?.dataset.root;
}

const mods = (e: KeyboardEvent | MouseEvent): Mods => ({
  ...(e.metaKey ? { meta: true } : {}), ...(e.ctrlKey ? { ctrl: true } : {}), ...(e.altKey ? { alt: true } : {}), ...(e.shiftKey ? { shift: true } : {}),
});

let installed = false;

/** Einmal beim Start (main.tsx): Sonde für Editoren und Ereignisse auf Dokument-Ebene (Erfassungsphase). */
export function installBugRecorder(win: Window & typeof globalThis = globalThis as Window & typeof globalThis) {
  if (installed) return;
  installed = true;
  setBlockEditorProbe((t) => {
    const list = blockEditors.get(t.rootID) ?? [];
    list.push(t);
    blockEditors.set(t.rootID, list);
    record(blockCheckpointOf(t));
    listenToPage(t.rootID);
    return () => {
      const l = blockEditors.get(t.rootID)?.filter((x) => x !== t) ?? [];
      if (l.length) blockEditors.set(t.rootID, l);
      else blockEditors.delete(t.rootID);
      listenToPage(t.rootID);
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
    record({ kind: "pointer", phase, x: Math.round(e.clientX), y: Math.round(e.clientY), button: e.button, detail: e.detail, target: describeElement(e.target as Element) });
    const root = rootOf(e.target);
    if (root) lastRoot = root;
    // Block-Editor: Auswahl per Maus (Klick, Ziehen, Blockauswahl) nach dem Loslassen – wird als „select“ wiedergegeben.
    // BSD-628: im nächsten Bild, spätestens nach 50 ms – WebKit drosselt requestAnimationFrame unter Last (und in
    // verdeckten Fenstern) so stark, dass das Bild erst nach ⇧⌘B kam und die Auswahl im Bericht fehlte.
    if (phase === "up" && root && blockEditors.has(root)) {
      let done = false;
      const select = () => {
        if (done) return;
        done = true;
        const t = currentBlock(root);
        if (t) record({ kind: "select", root, sel: blockSel(t), cause: "pointer" });
      };
      win.requestAnimationFrame(select);
      win.setTimeout(select, 50);
    }
  };
  doc.addEventListener("pointerdown", pointer("down"), opts);
  doc.addEventListener("pointerup", pointer("up"), opts);
  doc.addEventListener("focusin", (e) => {
    const root = rootOf(e.target);
    if (root) lastRoot = root;
    record({ kind: "focus", target: describeElement(e.target as Element) });
  }, opts);
}

// MARK: Zustand und Layout beim Melden

const FLOATING_HINT = "[role=menu],[role=listbox],[role=dialog],[role=tooltip],.bx-notice,.bx2-menu,.bx2-handle";
const MENU_SELECTOR = "[role=menu],[role=listbox],[role=dialog],.bx2-menu";
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
  // Block-Editor (ADR 0016): `.bx2-block` mit Typ und ID; markiert = Blockauswahl
  for (const el of doc.querySelectorAll<HTMLElement>(".bx2-block[data-block-id]")) {
    if (items.length > 400) break;
    if (excluded(el)) continue;
    const r = el.getBoundingClientRect();
    if (!visible(r, win)) continue;
    items.push({ kind: "block", label: `${el.dataset.type ?? "block"} #${el.dataset.blockId!}`, rect: rect(r), ...(el.hasAttribute("data-selected") ? { selected: true } : {}) });
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
  for (const el of doc.querySelectorAll(FLOATING_HINT)) floating(el, el.classList.contains("bx2-handle") ? "handle" : "floating");
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

export interface FrozenReport {
  at: number;
  events: RecordedEvent[];
  state: BugState;
  layout: LayoutItem[];
  env: BugEnv;
  app: BugApp;
  log: ReturnType<typeof diagnosticsLog.getSnapshot>;
  /** BSD-418: Hänger dieser und früherer Sitzungen. */
  hangs?: HangReport;
}

/** Den Zustand jetzt einfrieren (synchron, bevor der Dialog etwas verändert). */
export function freezeReport(win: Window = globalThis as unknown as Window): FrozenReport {
  const doc = win.document;
  const activeRoot = rootOf(doc.activeElement);
  const root = activeRoot ?? lastRoot ?? [...blockEditors.keys()].at(-1);
  const bt = root ? currentBlock(root) : undefined;
  const state: BugState = { menus: [...doc.querySelectorAll(MENU_SELECTOR)].filter((m) => !excluded(m) && m.getBoundingClientRect().width > 0).map((m) => describeElement(m)) };
  if (bt) {
    state.root = bt.rootID;
    try {
      const tree = blockDocOf(bt.store, bt.rootID);
      state.doc = tree;
      state.blocks = tree.blocks;
    } catch { /* Seite gerade weg */ }
    state.sel = blockSel(bt);
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
  return { at: Date.now(), events: recorder.snapshot(), state, layout: layoutSnapshot(win), env, app, log: diagnosticsLog.getSnapshot(), hangs: hangBundle() };
}

/**
 * BSD-642: Diese Eigenschaften übernimmt das Foto je Element (statt aller ~400). html-to-image kopiert sonst den
 * vollständigen berechneten Stil inline – in WebKit über `cssText` sogar immer, auch mit einer Liste. Das machte das
 * SVG mehrere MB groß; Klonen und Rastern dauerten in WebKit 1–1,9 s (unter Last über die 5-s-Grenze, Foto fehlte).
 * Mit der Liste: WebKit ~0,45 s, Chromium ~0,1 s, gleiches Bild. Fehlt eine Eigenschaft, die etwas sichtbar macht,
 * gehört sie hierher.
 */
export const SHOT_STYLE_PROPS: readonly string[] = [
  "display", "position", "top", "right", "bottom", "left", "z-index", "float", "clear", "box-sizing",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis", "order",
  "align-items", "align-self", "align-content", "justify-content", "justify-items", "justify-self",
  "grid-template-columns", "grid-template-rows", "grid-template-areas", "grid-auto-flow", "grid-auto-columns", "grid-auto-rows",
  "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end", "row-gap", "column-gap",
  "overflow-x", "overflow-y", "visibility", "opacity", "transform", "transform-origin", "clip-path", "isolation", "mix-blend-mode", "filter", "backdrop-filter",
  "color", "background-color", "background-image", "background-size", "background-position", "background-repeat", "background-clip", "background-origin",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "box-shadow", "outline-width", "outline-style", "outline-color", "outline-offset",
  "font-family", "font-size", "font-weight", "font-style", "font-variant-numeric", "font-feature-settings", "line-height", "letter-spacing", "word-spacing",
  "text-align", "text-indent", "text-transform", "text-decoration-line", "text-decoration-color", "text-decoration-style", "text-overflow", "text-shadow",
  "white-space", "word-break", "overflow-wrap", "vertical-align", "direction", "-webkit-line-clamp", "-webkit-box-orient",
  "list-style-type", "list-style-position", "object-fit", "object-position", "table-layout", "border-collapse", "border-spacing",
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "content", "caret-color", "aspect-ratio",
];

/**
 * Für die Dauer des Fotos liefert `getComputedStyle` ein leeres `cssText` – dann nimmt html-to-image die Liste oben
 * statt des ganzen Stils (WebKit füllt `cssText` sonst immer). Sonst unverändert; danach wieder das Original.
 */
async function withListedStyles<T>(win: Window, run: () => Promise<T>): Promise<T> {
  const w = win as { getComputedStyle: Window["getComputedStyle"] };
  const original = w.getComputedStyle;
  w.getComputedStyle = ((el: Element, pseudo?: string | null) => {
    const style = original.call(win, el, pseudo);
    return new Proxy(style, {
      get(target, key) {
        if (key === "cssText") return "";
        const v = Reflect.get(target, key, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }) as Window["getComputedStyle"];
  try {
    return await run();
  } finally {
    w.getComputedStyle = original;
  }
}

/** Bildschirmfoto des Fensters (DOM gerastert; der Melde-Dialog bleibt draußen). Scheitert still → undefined. */
export async function captureScreenshot(win: Window = globalThis as unknown as Window): Promise<Blob | undefined> {
  try {
    const { toBlob } = await import("html-to-image");
    const node = win.document.body;
    const backgroundColor = win.getComputedStyle(node).backgroundColor || undefined;
    const blob = await withListedStyles(win, () => toBlob(node, {
      width: win.innerWidth, height: win.innerHeight, pixelRatio: Math.min(2, win.devicePixelRatio || 1), cacheBust: false,
      filter: (n) => !(n instanceof Element && n.hasAttribute(REPORT_EXCLUDE)),
      includeStyleProperties: [...SHOT_STYLE_PROPS],
      ...(backgroundColor ? { backgroundColor } : {}),
    }));
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
    app: f.app, env: f.env, state: f.state, layout: f.layout, events: f.events, log: f.log, ...(f.hangs ? { hangs: f.hangs } : {}),
  });
}

// MARK: Haken für Tests und Wiedergabe

export interface ReplayHooks {
  /**
   * Editor der Wurzel: Dokument (JSON) und Auswahl setzen bzw. lesen. Block-Editor: `recordedRoot` ist die Seite beim
   * Aufzeichnen (Eltern in den Records zeigen auf sie).
   */
  load(root: string, doc: unknown, sel: SelectionInfo, recordedRoot?: string): boolean;
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
  // Block-Editor: aufgezeichnete Block-IDs → IDs auf der Wiedergabe-Seite
  const replayIDs = new Map<string, ReplayIDs>();
  const idsOf = (root: string): ReplayIDs => replayIDs.get(root) ?? { recordedRoot: root, root, ids: new Map() };
  const hooks: ReplayHooks = {
    load: (root, json, sel, recordedRoot) => {
      const bt = currentBlock(root);
      if (bt && isBlockDoc(json)) {
        const ids = loadBlockDoc(bt.store, root, recordedRoot ?? root, json);
        replayIDs.set(root, ids);
        bt.setSelection(resolveReplaySelection(bt.store, ids, sel));
        return true;
      }
      return false;
    },
    setSelection: (root, sel) => {
      const bt = currentBlock(root);
      if (bt) return bt.setSelection(resolveReplaySelection(bt.store, idsOf(root), sel));
      return false;
    },
    applySteps: (root, steps) => {
      const bt = currentBlock(root);
      if (!bt) return false;
      applyBlockChanges(bt.store, idsOf(root), steps as never);
      return true;
    },
    docJSON: (root) => {
      const bt = currentBlock(root);
      return bt ? blockDocOf(bt.store, root) : undefined;
    },
    roots: () => [...blockEditors.keys()],
    freeze: () => freezeReport(),
    bundle: (note, realText = false) => makeBundle(freezeReport(), note, { realText, screenshot: false }),
    recording: (on) => { recorder.on = on; },
  };
  (globalThis as { __basedReport?: ReplayHooks }).__basedReport = hooks;
}
