// BSD-264 (Whiteboard 2): die Board-Fläche als Ansicht. Dünn: Sitzung (session.ts) hält die Daten, der Controller
// (controller.ts) die Bedienung, render.ts zeichnet. Hier: Canvas an die Größe und Pixeldichte anpassen, Zeiger, Rad
// und Tasten weiterreichen, die schwebenden Pillen (Werkzeuge, Hinweis, Zoom, Undo) und die Minimap.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { registerContextItems } from "@based/ui/native";
import { BasedButton, BasedIconButton } from "@based/ui/astryx";
import { screenToWorld, zoomLabel, type Camera, type WorkspaceStore } from "@based/core";
import { BlockIcon, type BlockIconName } from "../blocks/icons.js";
import { BOARD_TOOLS, BoardController, minimapTransform, type BoardTool } from "./controller.js";
import { drawBoard, drawMinimap, readBoardTheme, type BoardTheme } from "./render.js";
import { BoardSession } from "./session.js";
import "./board.css";

export interface BoardViewProps {
  /** Replik der Seite (wie beim Editor): die Board-Seite und ihre Objekte. */
  store: WorkspaceStore;
  pageID: string;
  readOnly: boolean;
}

const TOOL_ICONS: Record<BoardTool, BlockIconName> = { select: "boardSelect", hand: "boardHand", note: "boardNote", shape: "boardShape" };
/** Kamera je Board für diese Sitzung der App merken (Tab-Wechsel, Vor/Zurück). */
const cameras = new Map<string, Camera>();
const isApple = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
const modKey = (key: string) => (isApple() ? `⌘${key}` : `Ctrl+${key}`);

/** Safari meldet Pinch als eigene Gesten-Ereignisse (kein Strg+Rad). */
interface GestureEvent extends UIEvent { scale: number; clientX: number; clientY: number }

export function BoardView({ store, pageID, readOnly }: BoardViewProps) {
  const [ctl, setCtl] = useState<BoardController>();
  useEffect(() => {
    const session = new BoardSession(store, pageID);
    const controller = new BoardController(session, { camera: cameras.get(pageID) });
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
  return ctl ? <BoardSurface key={pageID} ctl={ctl} /> : <div className="wb-root" aria-busy="true" />;
}

function BoardSurface({ ctl }: { ctl: BoardController }) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const minimap = useRef<HTMLCanvasElement>(null);
  // Die Pillen hängen an wenigen Werten; die Fläche selbst zeichnet ohne React (requestAnimationFrame).
  const session = ctl.session;
  useSyncExternalStore(ctl.subscribe, () =>
    [ctl.tool, zoomLabel(ctl.camera.zoom), session.canUndo, session.canRedo, session.objects.length, ctl.selection.size, ctl.announcement, ctl.hint].join("|"));
  const readOnly = ctl.readOnly;

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

    const draw = () => {
      frame = 0;
      const size = ctl.viewport;
      if (size.w <= 0 || size.h <= 0) return;
      const scene = ctl.scene();
      drawBoard(ctx, scene, theme, size, dpr, session.peers());
      el.style.cursor = ctl.cursorAt(lastPointer);
      if (mctx && mm && mmSize.w > 0) drawMinimap(mctx, session.objects, ctl.extent(), ctl.visible(), theme, mmSize, dpr);
    };
    const schedule = () => { frame ||= requestAnimationFrame(draw); };

    const resize = () => {
      const r = el.getBoundingClientRect();
      dpr = Math.min(3, window.devicePixelRatio || 1);
      const w = Math.round(r.width), h = Math.round(r.height);
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
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
    const themeWatch = new MutationObserver(() => { theme = readBoardTheme(el); schedule(); });
    themeWatch.observe(document.documentElement, { attributes: true });
    themeWatch.observe(document.body, { attributes: true });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => { theme = readBoardTheme(el); schedule(); };
    scheme.addEventListener("change", onScheme);

    const off = ctl.subscribe(schedule);

    const at = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const input = (e: PointerEvent) => ({ ...at(e), button: e.button, shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey });
    const onDown = (e: PointerEvent) => {
      if (e.target !== cv) return; // Pillen und Minimap gehören sich selbst
      el.focus({ preventScroll: true });
      lastPointer = at(e);
      ctl.pointerDown(input(e));
      if (ctl.busy) cv.setPointerCapture(e.pointerId);
      if (e.button === 1) e.preventDefault(); // kein Autoscroll-Kompass
    };
    const onMove = (e: PointerEvent) => {
      lastPointer = at(e);
      if (ctl.busy) ctl.pointerMove(input(e));
      else {
        session.setCursor(screenToWorld(ctl.camera, lastPointer));
        el.style.cursor = ctl.cursorAt(lastPointer);
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!ctl.busy) return;
      ctl.pointerUp(input(e));
      if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
    };
    const onCancel = () => ctl.cancel();
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

    return () => {
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
  const empty = session.objects.length === 0;
  return (
    <div ref={root} className="wb-root" tabIndex={0} role="application" aria-label="Board" aria-roledescription="whiteboard" data-testid="board"
      data-tool={ctl.tool} data-objects={session.objects.length} data-selected={ctl.selection.size}
      onKeyDown={(e) => {
        // Tasten in den Pillen (Leertaste/Enter auf einem Knopf, Tab zwischen Knöpfen) gehören den Knöpfen.
        if (e.target !== e.currentTarget) return;
        if (ctl.keyDown({ key: e.key, code: e.code, shift: e.shiftKey, alt: e.altKey, mod: e.metaKey || e.ctrlKey, repeat: e.repeat })) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onKeyUp={(e) => ctl.keyUp({ key: e.key })}>
      <canvas ref={canvas} className="wb-canvas" aria-hidden="true" />
      {empty ? (
        <div className="wb-empty">
          <p className="wb-empty-title">Nothing on this board yet</p>
          <p className="wb-empty-text">{readOnly ? "This board is read only." : "Press N for a sticky note or R for a shape, then click to place it."}</p>
        </div>
      ) : null}
      <div className="wb-hint" aria-hidden="true" data-testid="board-hint">{ctl.hint}</div>
      <div className="wb-pill wb-tools" role="toolbar" aria-label="Board tools">
        {BOARD_TOOLS.map((t) => (
          <BasedIconButton key={t.id} label={t.label} tooltip={`${t.label} (${t.key})`} size="md" pressed={ctl.tool === t.id} testID={`board-tool-${t.id}`}
            disabled={readOnly && (t.id === "note" || t.id === "shape")} icon={<BlockIcon name={TOOL_ICONS[t.id]} />}
            onClick={() => act(() => ctl.setTool(t.id))} />
        ))}
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
