// BSD-264 (Whiteboard 2): die Board-Fläche als Ansicht. Dünn: Sitzung (session.ts) hält die Daten, der Controller
// (controller.ts) die Bedienung, render.ts zeichnet. Hier: Canvas an die Größe und Pixeldichte anpassen, Zeiger, Rad
// und Tasten weiterreichen, die schwebenden Pillen (Werkzeuge, Hinweis, Zoom, Undo) und die Minimap.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { registerContextItems } from "@based/ui/native";
import { BasedButton, BasedIconButton } from "@based/ui/astryx";
import { boardFileView, isShape, screenToWorld, zoomLabel, type Camera, type WBShape, type WorkspaceStore } from "@based/core";
import { BlockIcon, type BlockIconName } from "../blocks/icons.js";
import { BOARD_TOOLS, BoardController, HIGHLIGHT_COLORS, isEditTool, minimapTransform, PEN_COLORS, type BoardEdit, type BoardFile, type BoardTool } from "./controller.js";
import { BoardImageCache } from "./images.js";
import { BoardPdfCache, pdfPageSizes } from "./pdf.js";
import { BoardTextCache } from "./texts.js";
import { PREVIEW_HEADER } from "./render.js";
import { PASTE_TEXT_MAX } from "./controller.js";
import { drawBoardObjects, drawBoardOverlay, drawLiveInk, drawMinimap, highlightToken, penToken, readBoardTheme, type BoardTheme } from "./render.js";
import { BoardSession } from "./session.js";
import "./board.css";

export interface BoardViewProps {
  /** Replik der Seite (wie beim Editor): die Board-Seite und ihre Objekte. */
  store: WorkspaceStore;
  pageID: string;
  readOnly: boolean;
  /** Dateispeicher der App (wie im Editor): Datei ablegen → Adresse; Adresse → abrufbare URL. Ohne: keine Dateien. */
  uploadFile?: (file: File) => Promise<string>;
  resolveFileUrl?: (url: string) => Promise<string>;
}

interface FileHost { upload: ((file: File) => Promise<string>) | undefined; resolve: ((url: string) => Promise<string>) | undefined }

/** Höchstens so viel HTML wird für die Vorschau gelesen, und so viele eingebettete Vorschauen laufen gleichzeitig. */
const HTML_PREVIEW_BYTES = 2 * 1024 * 1024;
const EMBEDS_MAX = 4;
/** Vorschau ohne Netz und ohne Skripte: die Datei darf nichts nachladen und nichts ausführen. */
const HTML_GUARD = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:"><base target="_blank">`;
const isEmbed = (o: { kind: string; style?: Record<string, unknown> | undefined }) => o.kind === "file" && (o.style?.view === "html" || o.style?.view === "video" || o.style?.view === "audio");

/** Eingebetteter Inhalt einer Vorschau-Karte (HTML, Video, Audio) – nur da, solange die Karte zu sehen ist. */
function BoardEmbed({ obj, camera, active, resolve }: { obj: WBShape; camera: Camera; active: boolean; resolve: ((url: string) => Promise<string>) | undefined }) {
  const view = String(obj.style?.view);
  const [src, setSrc] = useState<{ url?: string; html?: string; failed?: boolean }>({});
  const ref = obj.ref;
  useEffect(() => {
    let alive = true;
    if (!ref || !resolve) { setSrc({ failed: true }); return; }
    void (async () => {
      try {
        const url = await resolve(ref);
        if (view !== "html") { if (alive) setSrc({ url }); return; }
        const blob = await (await fetch(url)).blob();
        const html = await blob.slice(0, HTML_PREVIEW_BYTES).text();
        if (alive) setSrc({ html: HTML_GUARD + html });
      } catch {
        if (alive) setSrc({ failed: true });
      }
    })();
    return () => { alive = false; };
  }, [ref, resolve, view]);
  const style = {
    left: (obj.x - camera.x) * camera.zoom, top: (obj.y + PREVIEW_HEADER - camera.y) * camera.zoom, width: obj.w, height: Math.max(0, obj.h - PREVIEW_HEADER),
    transform: `scale(${camera.zoom})`,
  };
  const name = String(obj.style?.name ?? "File");
  return (
    <div className="wb-embed" data-view={view} data-active={active ? "" : undefined} data-testid="board-embed" style={style}>
      {src.failed ? <p className="wb-embed-note">This file can't be shown right now.</p>
        : view === "html" && src.html !== undefined ? <iframe className="wb-embed-frame" title={name} sandbox="" srcDoc={src.html} loading="lazy" referrerPolicy="no-referrer" />
          : view === "video" && src.url ? <video className="wb-embed-media" src={src.url} controls preload="metadata" playsInline aria-label={name} />
            : view === "audio" && src.url ? <audio className="wb-embed-audio" src={src.url} controls preload="metadata" aria-label={name} />
              : <p className="wb-embed-note">Loading…</p>}
    </div>
  );
}

/** Maße eines Bildes lesen, ohne es ganz zu entpacken zu behalten. */
async function imageSize(file: File): Promise<{ width: number; height: number } | undefined> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return undefined;
  try {
    const bmp = await createImageBitmap(file);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  } catch {
    return undefined; // z. B. SVG in manchen Browsern, kaputte Datei: dann eben als Dateikarte
  }
}

const TOOL_ICONS: Record<BoardTool, BlockIconName> = {
  select: "boardSelect", hand: "boardHand", pen: "boardPen", highlighter: "boardHighlighter", eraser: "boardEraser", lasso: "boardLasso",
  text: "boardText", note: "boardNote", shape: "boardShape", connector: "boardConnector", frame: "boardFrame",
};
const COLOR_NAMES: Record<string, string> = { ink: "Ink", blue: "Blue", red: "Red", green: "Green", purple: "Purple", sky: "Sky", rose: "Rose", mint: "Mint", lilac: "Lilac" };
const WIDTH_NAMES = ["Fine", "Medium", "Bold"] as const;
/** Schrift des Eingabefelds je Objektart – dieselben Maße, mit denen render.ts den Text zeichnet. */
const EDIT_TYPE: Record<BoardEdit["kind"], { size: number; weight: number; leading: number; pad: number }> = {
  text: { size: 17, weight: 400, leading: 1.5, pad: 0 }, note: { size: 15, weight: 500, leading: 1.4, pad: 14 }, shape: { size: 14, weight: 500, leading: 1.4, pad: 12 },
  frame: { size: 13, weight: 600, leading: 1.4, pad: 14 }, connector: { size: 12, weight: 500, leading: 1.4, pad: 6 },
};
/** Sobald in dieser Sitzung ein Stift benutzt wurde, verschiebt der Finger (statt zu zeichnen). */
let penSeen = false;
/** Obergrenze der Canvas-Pixel: große Bildschirme mit hoher Dichte zeichnen mit etwas weniger Auflösung statt zu ruckeln. */
const MAX_CANVAS_PIXELS = 9_000_000;
/** Kamera je Board für diese Sitzung der App merken (Tab-Wechsel, Vor/Zurück). */
const cameras = new Map<string, Camera>();
const isApple = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
const modKey = (key: string) => (isApple() ? `⌘${key}` : `Ctrl+${key}`);

/** Safari meldet Pinch als eigene Gesten-Ereignisse (kein Strg+Rad). */
interface GestureEvent extends UIEvent { scale: number; clientX: number; clientY: number }

export function BoardView({ store, pageID, readOnly, uploadFile, resolveFileUrl }: BoardViewProps) {
  const [ctl, setCtl] = useState<BoardController>();
  const host = useRef<FileHost>({ upload: uploadFile, resolve: resolveFileUrl });
  host.current = { upload: uploadFile, resolve: resolveFileUrl };
  useEffect(() => {
    const session = new BoardSession(store, pageID);
    const controller = new BoardController(session, {
      camera: cameras.get(pageID),
      // Öffnen heißt sichern: eine Datei (etwa HTML) läuft nie im Fenster der App.
      onOpenFile: (o) => {
        const resolve = host.current.resolve;
        if (!o.ref || !resolve) return;
        void resolve(o.ref).then((url) => {
          const a = document.createElement("a");
          a.href = url;
          a.download = String(o.style?.name ?? "file");
          a.click();
        }).catch(() => undefined);
      },
    });
    setCtl(controller);
    return () => {
      // Nur merken, wenn die Fläche je eine Größe hatte (StrictMode räumt einmal ab, bevor es ein Layout gab).
      if (controller.laidOut) cameras.set(pageID, controller.camera);
      controller.destroy();
      session.destroy();
      setCtl(undefined);
    };
  }, [store, pageID]);
  // Seite nur lesbar (Papierkorb, gesperrt, Gast): die Sitzung nimmt dann keine Änderungen an.
  useEffect(() => { ctl?.session.setLocked(readOnly); }, [ctl, readOnly]);
  return ctl ? <BoardSurface key={pageID} ctl={ctl} host={host} /> : <div className="wb-root" aria-busy="true" />;
}

function BoardSurface({ ctl, host }: { ctl: BoardController; host: { current: FileHost } }) {
  const picker = useRef<HTMLInputElement>(null);
  // Gleichbleibende Funktion für die eingebetteten Vorschauen (die App reicht bei jedem Zeichnen eine neue herein).
  const resolveFile = useRef((url: string) => host.current.resolve?.(url) ?? Promise.reject(new Error("no file store"))).current;
  const [busyFiles, setBusyFiles] = useState(0);
  /** Dateien in den Speicher legen und als Objekte ablegen (`at`: Stelle auf der Fläche in CSS-px, sonst Mitte). */
  const addFiles = async (list: readonly File[], at?: { x: number; y: number }) => {
    const upload = host.current.upload;
    if (!upload || ctl.readOnly || list.length === 0) return;
    setBusyFiles((n) => n + list.length);
    try {
      const done: BoardFile[] = [];
      for (const file of list) {
        try {
          const name = file.name || "Untitled", mime = file.type || "application/octet-stream";
          const view = boardFileView(name, mime);
          // PDF: Seitenmaße lesen, damit jede Seite als eigenes Objekt in ihrer Form entsteht. Scheitert das
          // (verschlüsselt, kaputt), bleibt es eine Dateikarte.
          const [ref, size, pages] = await Promise.all([
            upload(file), view === "image" ? imageSize(file) : undefined,
            view === "pdf" ? file.arrayBuffer().then(pdfPageSizes).catch(() => undefined) : undefined,
          ]);
          done.push({ ref, name, mime, size: file.size, ...(size ?? {}), ...(pages?.length ? { pages } : {}) });
        } catch { /* diese Datei ließ sich nicht ablegen; die anderen kommen trotzdem */ }
      }
      ctl.addFiles(done, at ? screenToWorld(ctl.camera, at) : undefined);
    } finally {
      setBusyFiles((n) => n - list.length);
    }
  };
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const minimap = useRef<HTMLCanvasElement>(null);
  // Die Pillen hängen an wenigen Werten; die Fläche selbst zeichnet ohne React (requestAnimationFrame).
  const session = ctl.session;
  // Eingebettete Vorschauen (HTML, Video, Audio) sind echte Elemente über der Fläche: nur die sichtbaren, nur wenn
  // sie groß genug sind, höchstens EMBEDS_MAX. Gibt es auf dem Board keine, kostet das nichts.
  const embedCount = useRef({ version: -1, any: false });
  const visibleEmbeds = (): WBShape[] => {
    if (embedCount.current.version !== session.version) embedCount.current = { version: session.version, any: session.objects.some(isEmbed) };
    if (!embedCount.current.any || ctl.viewport.w <= 0) return [];
    return ctl.scene().objects.filter((o): o is WBShape => isShape(o) && isEmbed(o) && o.w * ctl.camera.zoom >= 180).slice(-EMBEDS_MAX);
  };
  const embedKey = () => {
    const list = visibleEmbeds();
    return list.length === 0 ? "" : `${ctl.camera.x},${ctl.camera.y},${ctl.camera.zoom}|${ctl.busy ? 1 : 0}|${list.map((o) => `${o.id}:${o.x},${o.y},${o.w},${o.h}`).join(";")}`;
  };
  useSyncExternalStore(ctl.subscribe, () =>
    [ctl.tool, zoomLabel(ctl.camera.zoom), session.canUndo, session.canRedo, session.objects.length, ctl.selection.size, ctl.announcement, ctl.hint,
      ctl.pen.color, ctl.pen.width, ctl.highlighter.color, ctl.highlighter.width, ctl.shapeKind, embedKey(), ctl.editing ? `${ctl.editing.id ?? "new"}@${ctl.camera.x},${ctl.camera.y}` : ""].join("|"));
  const readOnly = ctl.readOnly;
  const embeds = visibleEmbeds();

  useEffect(() => {
    const el = root.current, cv = canvas.current, mm = minimap.current;
    if (!el || !cv) return;
    const ctx = cv.getContext("2d");
    const mctx = mm?.getContext("2d") ?? null;
    if (!ctx) return;
    let theme: BoardTheme = readBoardTheme(el);
    let frame = 0;
    let dpr = 1;
    let mmSize = { w: 0, h: 0 };
    let lastPointer = { x: -1, y: -1 };
    // Ebene mit Untergrund und Objekten. Solange nur der laufende Strich wächst, wird sie nicht neu gezeichnet:
    // je Bild ein Kopieren plus ein Strich – das hält das Schreiben auch auf schwachen Geräten flüssig.
    const layer = document.createElement("canvas");
    const lctx = layer.getContext("2d");
    let layerKey = "";
    let themeVersion = 0;
    // Bilder: erst laden, wenn sie zu sehen sind; verkleinert entpackt; begrenzte Zahl im Speicher.
    const loaded = () => { layerKey = ""; schedule(); };
    const imageCache = new BoardImageCache((ref) => host.current.resolve?.(ref), loaded);
    const textCache = new BoardTextCache((ref) => host.current.resolve?.(ref), loaded);
    const pdfCache = new BoardPdfCache((ref) => host.current.resolve?.(ref), loaded);
    const images = { get: { image: imageCache.get, text: textCache.get, pdf: pdfCache.get }, destroy: () => { imageCache.destroy(); textCache.destroy(); pdfCache.destroy(); } };

    const draw = () => {
      frame = 0;
      const size = ctl.viewport;
      if (size.w <= 0 || size.h <= 0) return;
      const scene = ctl.scene();
      const live = ctl.liveInk;
      if (lctx && layer.width > 0) {
        const key = `${ctl.version}|${session.version}|${layer.width}x${layer.height}|${themeVersion}`;
        if (key !== layerKey) { drawBoardObjects(lctx, scene, theme, size, dpr, images.get); layerKey = key; }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(layer, 0, 0);
      } else drawBoardObjects(ctx, scene, theme, size, dpr, images.get);
      if (live) drawLiveInk(ctx, live, theme, scene.camera, dpr);
      drawBoardOverlay(ctx, scene, theme, dpr, session.peers());
      el.style.cursor = ctl.cursorAt(lastPointer);
      if (mctx && mm && mmSize.w > 0) drawMinimap(mctx, session.objects, ctl.extent(), ctl.visible(), theme, mmSize, dpr);
    };
    function schedule() { frame ||= requestAnimationFrame(draw); }

    const resize = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width), h = Math.round(r.height);
      dpr = Math.min(3, window.devicePixelRatio || 1);
      if (w * h * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, w * h)));
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        layer.width = cv.width;
        layer.height = cv.height;
        layerKey = "";
      }
      if (mm) {
        mmSize = { w: mm.clientWidth, h: mm.clientHeight };
        mm.width = Math.round(mmSize.w * dpr);
        mm.height = Math.round(mmSize.h * dpr);
      }
      ctl.setViewport({ w, h });
      schedule();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    // Pixeldichte ändert sich beim Wechsel des Bildschirms oder Browser-Zoom.
    let dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const onDpr = () => {
      dprQuery.removeEventListener("change", onDpr);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener("change", onDpr);
      resize();
    };
    dprQuery.addEventListener("change", onDpr);
    // Hell/Dunkel, Stil, Akzent: die Tokens hängen an Attributen der Wurzel.
    const themeWatch = new MutationObserver(() => { theme = readBoardTheme(el); themeVersion += 1; schedule(); });
    themeWatch.observe(document.documentElement, { attributes: true });
    themeWatch.observe(document.body, { attributes: true });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => { theme = readBoardTheme(el); themeVersion += 1; schedule(); };
    scheme.addEventListener("change", onScheme);

    const off = ctl.subscribe(schedule);

    const at = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const input = (e: PointerEvent, pan = false) => ({
      ...at(e), button: e.button, shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey, pan,
      // Druck nur vom Stift: Maus und Finger melden feste Werte, daraus würde ein starrer Strich.
      ...(e.pointerType === "pen" ? { pressure: e.pressure } : {}),
      // Umgedrehter Stift / Radier-Taste (button 5 bzw. Bit 32).
      eraser: e.pointerType === "pen" && (e.button === 5 || (e.buttons & 32) !== 0),
    });
    // Finger: einer bedient (oder verschiebt, wenn ein Stift im Spiel ist), zwei zoomen und verschieben.
    const touches = new Map<number, { x: number; y: number }>();
    let active: number | undefined; // Zeiger, dem die laufende Geste gehört
    let penDown = false;
    let pinch: { dist: number; mid: { x: number; y: number } } | undefined;
    const pinchState = () => {
      const [a, b] = [...touches.values()];
      return a && b ? { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } } : undefined;
    };
    const onDown = (e: PointerEvent) => {
      if (e.target !== cv) return; // Pillen und Minimap gehören sich selbst
      el.focus({ preventScroll: true });
      lastPointer = at(e);
      if (e.pointerType === "touch") {
        if (penDown) return; // Handballen neben dem Stift
        touches.set(e.pointerId, at(e));
        cv.setPointerCapture(e.pointerId);
        if (touches.size === 2) {
          ctl.cancel(); // der halbe Strich des ersten Fingers zählt nicht
          active = undefined;
          pinch = pinchState();
          return;
        }
        if (touches.size > 2) return;
        const drawing = ctl.tool === "pen" || ctl.tool === "highlighter" || ctl.tool === "eraser" || ctl.tool === "lasso";
        ctl.pointerDown(input(e, penSeen && drawing));
        active = ctl.busy ? e.pointerId : undefined;
        return;
      }
      if (e.pointerType === "pen") {
        penSeen = true;
        penDown = true;
        // Finger, die schon aufliegen, gehören zum Handballen.
        if (touches.size) { touches.clear(); pinch = undefined; ctl.cancel(); }
      }
      ctl.pointerDown(input(e));
      if (ctl.busy) { cv.setPointerCapture(e.pointerId); active = e.pointerId; }
      if (e.button === 1) e.preventDefault(); // kein Autoscroll-Kompass
    };
    const onMove = (e: PointerEvent) => {
      lastPointer = at(e);
      if (e.pointerType === "touch" && touches.has(e.pointerId)) {
        touches.set(e.pointerId, at(e));
        if (pinch && touches.size >= 2) {
          const now = pinchState()!;
          if (pinch.dist > 0 && now.dist > 0) ctl.pinch(now.dist / pinch.dist, now.mid);
          ctl.panScreen(now.mid.x - pinch.mid.x, now.mid.y - pinch.mid.y);
          pinch = now;
          return;
        }
      }
      if (ctl.busy && e.pointerId === active) {
        // Der Browser fasst schnelle Bewegungen zusammen; für die Tinte zählt jeder einzelne Punkt.
        const parts = ctl.inking && typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
        if (parts.length > 1) for (const part of parts) ctl.pointerMove(input(part));
        else ctl.pointerMove(input(e));
      } else if (!ctl.busy) {
        session.setCursor(screenToWorld(ctl.camera, lastPointer));
        el.style.cursor = ctl.cursorAt(lastPointer);
      }
    };
    const release = (e: PointerEvent) => {
      if (e.pointerType === "pen") penDown = false;
      if (touches.delete(e.pointerId) && touches.size < 2) pinch = undefined;
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      const mine = ctl.busy && e.pointerId === active;
      release(e);
      if (!mine) return;
      active = undefined;
      ctl.pointerUp(input(e));
    };
    const onCancel = (e: PointerEvent) => {
      release(e);
      if (e.pointerId === active || active === undefined) { active = undefined; ctl.cancel(); }
    };
    const onLeave = () => session.setCursor(undefined);
    // Rad: selbst behandeln und nicht weiterreichen – sonst rollt die Seite und das waagrechte Wischen der App
    // (Zurück/Vor, shell/historyGestures.ts) greift mitten im Verschieben der Fläche.
    const onWheel = (e: WheelEvent) => {
      // Auch über den Pillen: sonst blättert ein Wisch, der dort beginnt, in der App zurück.
      e.preventDefault();
      e.stopPropagation();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? ctl.viewport.h : 1;
      ctl.wheel({ ...at(e), deltaX: (e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX) * k, deltaY: (e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY) * k, zoom: e.ctrlKey || e.metaKey });
    };
    let lastScale = 1;
    const onGestureStart = (e: Event) => { e.preventDefault(); lastScale = 1; };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      if (g.scale > 0) ctl.pinch(g.scale / lastScale, at(g));
      lastScale = g.scale || 1;
    };
    cv.addEventListener("pointerdown", onDown);
    cv.addEventListener("pointermove", onMove);
    cv.addEventListener("pointerup", onUp);
    cv.addEventListener("pointercancel", onCancel);
    cv.addEventListener("pointerleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    const onBlur = () => ctl.blur();
    el.addEventListener("blur", onBlur);

    // Dateien: auf die Fläche ziehen oder einfügen.
    const hasFiles = (t: DataTransfer | null) => !!t && [...t.types].includes("Files");
    const onDragOver = (e: DragEvent) => { if (hasFiles(e.dataTransfer) && host.current.upload && !ctl.readOnly) { e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; } };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e.dataTransfer) || !host.current.upload || ctl.readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      void addFiles([...e.dataTransfer!.files], at(e));
    };
    const onPaste = (e: ClipboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement) return;
      if (ctl.readOnly) return;
      const list = [...(e.clipboardData?.files ?? [])];
      if (list.length > 0) {
        if (!host.current.upload) return;
        e.preventDefault();
        void addFiles(list);
        return;
      }
      // Text: kurz als Text-Objekt, lang (ein Log, ein Chat-Verlauf) als Datei mit Vorschau – so bleibt das Board klein.
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (text.trim() === "") return;
      e.preventDefault();
      if (text.length <= PASTE_TEXT_MAX || !host.current.upload) ctl.addText(text.slice(0, 20_000));
      else void addFiles([new File([text], /^\s*[{[]/.test(text) ? "Pasted text.jsonl" : "Pasted text.txt", { type: "text/plain" })]);
    };
    el.addEventListener("dragover", onDragOver);
    el.addEventListener("drop", onDrop);
    el.addEventListener("paste", onPaste);

    return () => {
      el.removeEventListener("dragover", onDragOver);
      el.removeEventListener("drop", onDrop);
      el.removeEventListener("paste", onPaste);
      images.destroy();
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      themeWatch.disconnect();
      dprQuery.removeEventListener("change", onDpr);
      scheme.removeEventListener("change", onScheme);
      off();
      cv.removeEventListener("pointerdown", onDown);
      cv.removeEventListener("pointermove", onMove);
      cv.removeEventListener("pointerup", onUp);
      cv.removeEventListener("pointercancel", onCancel);
      cv.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("blur", onBlur);
    };
  }, [ctl, session]);

  // Rechtsklick: Based-Menü mit den Befehlen für die Auswahl (nie das Systemmenü).
  useEffect(() => registerContextItems((info) => {
    if (info.target !== canvas.current) return [];
    const some = ctl.selection.size > 0;
    const edit = !readOnly;
    return [
      ...(edit && some ? [
        { label: "Duplicate", icon: "duplicate", hint: modKey("D"), run: () => void ctl.duplicateSelection() },
        { label: "Bring to front", icon: "moveUp", run: () => void ctl.reorder("front") },
        { label: "Send to back", icon: "moveDown", run: () => void ctl.reorder("back") },
        { label: "Delete", icon: "trash", danger: true, run: () => void ctl.deleteSelection() },
        { separator: true as const },
      ] : []),
      { label: "Select all", icon: "selectAll", hint: modKey("A"), run: () => ctl.selectAll() },
      { label: "Zoom to fit", hint: modKey("0"), run: () => ctl.fit() },
      { separator: true as const },
    ];
  }), [ctl, readOnly]);

  // Minimap: klicken oder ziehen setzt den Ausschnitt.
  const jump = (e: { clientX: number; clientY: number; currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = minimapTransform(ctl.extent(), ctl.visible(), { w: r.width, h: r.height });
    ctl.centerOn({ x: (e.clientX - r.left - t.x) / t.scale, y: (e.clientY - r.top - t.y) / t.scale });
  };

  // Nach einem Klick auf eine Pille geht der Fokus zurück auf die Fläche: V, N, ⌘Z wirken sofort weiter.
  const act = (run: () => void) => { run(); root.current?.focus({ preventScroll: true }); };
  const empty = session.objects.length === 0 && !ctl.editing;
  const canFiles = !readOnly && host.current.upload !== undefined;
  const inkTool = ctl.tool === "pen" || ctl.tool === "highlighter";
  const inkStyle = ctl.tool === "highlighter" ? ctl.highlighter : ctl.pen;
  const edit = ctl.editing;
  const editType = edit ? EDIT_TYPE[edit.kind] : undefined;
  const commit = (el: HTMLTextAreaElement, next = false) => { ctl.commitEdit(el.value, { height: el.scrollHeight, next }); if (!next) root.current?.focus({ preventScroll: true }); };
  return (
    <div ref={root} className="wb-root" tabIndex={0} role="application" aria-label="Board" aria-roledescription="whiteboard" data-testid="board"
      data-tool={ctl.tool} data-editing={edit ? "" : undefined} data-objects={session.objects.length} data-selected={ctl.selection.size}
      onKeyDown={(e) => {
        // Tasten in den Pillen (Leertaste/Enter auf einem Knopf, Tab zwischen Knöpfen) gehören den Knöpfen.
        if (e.target !== e.currentTarget) return;
        if (ctl.keyDown({ key: e.key, code: e.code, shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey, repeat: e.repeat })) {
          e.preventDefault();
          e.stopPropagation();
        } else if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "i" && canFiles) {
          e.preventDefault();
          picker.current?.click();
        }
      }}
      onKeyUp={(e) => ctl.keyUp({ key: e.key })}>
      <canvas ref={canvas} className="wb-canvas" aria-hidden="true" />
      {empty ? (
        <div className="wb-empty">
          <p className="wb-empty-title">Nothing on this board yet</p>
          <p className="wb-empty-text">{readOnly ? "This board is read only." : "Press P to draw, N for a sticky note, or double-click anywhere to type."}</p>
        </div>
      ) : null}
      {edit && editType ? (
        <textarea key={edit.id ?? "new"} className="wb-edit" data-kind={edit.kind} data-testid="board-edit" aria-label="Text" defaultValue={edit.text} autoFocus spellCheck
          rows={1}
          style={{
            left: (edit.rect.x - ctl.camera.x) * ctl.camera.zoom, top: (edit.rect.y - ctl.camera.y) * ctl.camera.zoom, width: edit.rect.w, height: edit.kind === "text" ? undefined : edit.rect.h,
            minHeight: edit.rect.h, transform: `scale(${ctl.camera.zoom})`, padding: editType.pad, fontSize: editType.size, fontWeight: editType.weight, lineHeight: editType.leading,
          }}
          onFocus={(e) => { const n = e.currentTarget.value.length; e.currentTarget.setSelectionRange(n, n); }}
          onInput={(e) => { if (edit.kind === "text") { const t = e.currentTarget; t.style.height = "auto"; t.style.height = `${t.scrollHeight}px`; } }}
          onBlur={(e) => { if (ctl.editing === edit) commit(e.currentTarget); }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey || edit.kind === "frame" || edit.kind === "connector"))) { e.preventDefault(); commit(e.currentTarget); }
            else if (e.key === "Tab" && edit.kind === "note") { e.preventDefault(); commit(e.currentTarget, true); }
          }} />
      ) : null}
      {embeds.map((o) => (
        <BoardEmbed key={o.id} obj={o} camera={ctl.camera} resolve={resolveFile}
          active={ctl.tool === "select" && ctl.selection.size === 1 && ctl.selection.has(o.id) && !ctl.busy} />
      ))}
      {inkTool && !readOnly ? (
        <div className="wb-pill wb-options" role="toolbar" aria-label={ctl.tool === "pen" ? "Pen options" : "Highlighter options"} data-testid="board-options">
          {(ctl.tool === "pen" ? PEN_COLORS : HIGHLIGHT_COLORS).map((c) => (
            <BasedIconButton key={c} label={`${COLOR_NAMES[c]} colour`} pressed={inkStyle.color === c} testID={`board-color-${c}`}
              icon={<span className="wb-swatch" style={{ background: `var(${ctl.tool === "pen" ? penToken(c) : highlightToken(c)})` }} />}
              onClick={() => act(() => ctl.setInkStyle({ color: c }))} />
          ))}
          <span className="wb-sep" aria-hidden="true" />
          {WIDTH_NAMES.map((name, i) => (
            <BasedIconButton key={name} label={`${name} stroke`} pressed={inkStyle.width === i} testID={`board-width-${i}`}
              icon={<span className="wb-dot" data-size={i} />} onClick={() => act(() => ctl.setInkStyle({ width: i }))} />
          ))}
        </div>
      ) : null}
      <div className="wb-hint" aria-hidden="true" data-testid="board-hint">{ctl.hint}</div>
      <div className="wb-pill wb-tools" role="toolbar" aria-label="Board tools">
        {BOARD_TOOLS.flatMap((t) => [
          ...(t.group ? [<span key={`${t.id}-sep`} className="wb-sep" aria-hidden="true" />] : []),
          <BasedIconButton key={t.id} label={t.label} tooltip={`${t.label} (${t.key})`} size="md" pressed={ctl.tool === t.id} testID={`board-tool-${t.id}`}
            disabled={readOnly && isEditTool(t.id)} icon={<BlockIcon name={TOOL_ICONS[t.id]} />}
            onClick={() => act(() => ctl.setTool(t.id))} />,
        ])}
        {host.current.upload ? (
          <>
            <span className="wb-sep" aria-hidden="true" />
            <BasedIconButton label={busyFiles > 0 ? "Adding files…" : "Image or file"} tooltip="Image or file (⇧I) · or drop files on the board" size="md" disabled={!canFiles || busyFiles > 0}
              testID="board-tool-file" icon={<BlockIcon name="boardImage" />} onClick={() => picker.current?.click()} />
            <input ref={picker} type="file" multiple hidden aria-label="Add files to the board" data-testid="board-file-input"
              onChange={(e) => { const list = [...(e.target.files ?? [])]; e.target.value = ""; void addFiles(list).then(() => root.current?.focus({ preventScroll: true })); }} />
          </>
        ) : null}
      </div>
      <div className="wb-pill wb-history" role="group" aria-label="History">
        <BasedIconButton label="Undo" tooltip={`Undo (${modKey("Z")})`} disabled={readOnly || !session.canUndo} icon={<BlockIcon name="boardUndo" />} testID="board-undo" onClick={() => act(() => ctl.undo())} />
        <BasedIconButton label="Redo" tooltip={`Redo (${isApple() ? "⇧⌘Z" : "Ctrl+Y"})`} disabled={readOnly || !session.canRedo} icon={<BlockIcon name="boardRedo" />} testID="board-redo" onClick={() => act(() => ctl.redo())} />
      </div>
      <div className="wb-corner">
        <div className="wb-minimap" data-testid="board-minimap"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); jump(e); }}
          onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) jump(e); }}>
          <canvas ref={minimap} className="wb-minimap-canvas" role="img" aria-label="Minimap of the board" />
        </div>
        <div className="wb-pill wb-zoom" role="group" aria-label="Zoom">
          <BasedIconButton label="Zoom out" tooltip={`Zoom out (${modKey("−")})`} icon={<BlockIcon name="boardZoomOut" />} testID="board-zoom-out" onClick={() => act(() => ctl.zoomOut())} />
          <span className="wb-zoom-label" data-testid="board-zoom">{zoomLabel(ctl.camera.zoom)}</span>
          <BasedIconButton label="Zoom in" tooltip={`Zoom in (${modKey("+")})`} icon={<BlockIcon name="boardZoomIn" />} testID="board-zoom-in" onClick={() => act(() => ctl.zoomIn())} />
          <span className="wb-sep" aria-hidden="true" />
          <BasedButton label="Fit" variant="ghost" size="sm" ariaLabel="Zoom to fit" onClick={() => act(() => ctl.fit())} />
        </div>
      </div>
      <div className="wb-live" role="status" aria-live="polite">{ctl.announcement}</div>
    </div>
  );
}
