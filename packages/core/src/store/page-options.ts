// BSD-201: Seiten-Optionen wie Swift PageOps (`setPageIcon`, `setPageFormat`): Icon, Schrift, Small text, Full width,
// Sperre. Je ein Undo-Schritt; leere Werte werden entfernt (keine `format: {}`-Reste), damit Records klein bleiben.
import type { Block } from "../model/records.js";
import type { WorkspaceStore } from "./store.js";

export type PageFont = "default" | "serif" | "mono";
export interface PageFormatPatch {
  font?: PageFont | undefined;
  smallText?: boolean | undefined;
  fullWidth?: boolean | undefined;
  locked?: boolean | undefined;
}

type Format = NonNullable<NonNullable<Block["props"]>["format"]>;

function clean(props: NonNullable<Block["props"]>, b: Block) {
  if (props.format && Object.keys(props.format).length === 0) delete props.format;
  if (Object.keys(props).length > 0) b.props = props;
  else delete b.props;
}

/** Emoji als Icon setzen (Swift: `.emoji` wird als reiner String gespeichert) oder mit `undefined` entfernen. */
export function setPageIcon(store: WorkspaceStore, id: string, emoji: string | undefined): void {
  const b = store.blocks.get(id);
  if (!b) return;
  const cur = b.props?.icon;
  if ((typeof cur === "string" ? cur : undefined) === emoji && (emoji !== undefined || cur === undefined)) return;
  store.transact(emoji ? "Change icon" : "Remove icon", (tx) => tx.update(id, (x) => {
    const props = { ...(x.props ?? {}) };
    if (emoji) props.icon = emoji;
    else delete props.icon;
    clean(props, x);
  }));
}

/** Format-Felder ändern; `false`/`"default"`/`undefined` entfernt das Feld (Standard). */
export function setPageFormat(store: WorkspaceStore, id: string, patch: PageFormatPatch): void {
  if (!store.blocks.has(id)) return;
  store.transact(patch.locked !== undefined ? (patch.locked ? "Lock page" : "Unlock page") : "Page settings", (tx) => tx.update(id, (x) => {
    const props = { ...(x.props ?? {}) };
    const format: Format = { ...(props.format ?? {}) };
    for (const [k, v] of Object.entries(patch) as [keyof PageFormatPatch, unknown][]) {
      if (!(k in patch)) continue;
      if (v === undefined || v === false || v === "default") delete format[k];
      else (format as Record<string, unknown>)[k] = v;
    }
    props.format = format;
    clean(props, x);
  }));
}

/** Aktuelles Format einer Seite (fehlende Felder = Standard). */
export function pageFormat(store: WorkspaceStore, id: string): { font: PageFont; smallText: boolean; fullWidth: boolean; locked: boolean } {
  const f = store.blocks.get(id)?.props?.format;
  return { font: (f?.font as PageFont | undefined) ?? "default", smallText: f?.smallText === true, fullWidth: f?.fullWidth === true, locked: f?.locked === true };
}

// MARK: BSD-201 Teil 2 – Cover und Bild-Icon (Swift PageOps.setPageCover, PageIcon.asset/.url)

export interface CoverAsset { id: string; name: string; size?: number; mime?: string }
/** Wie Swift `PageCover` (Codable-Enum mit `_0`). */
export type PageCoverValue = { gradient: { _0: number } } | { color: { _0: string } } | { asset: { _0: CoverAsset } } | { url: { _0: string } };

/** Cover setzen oder entfernen (dann auch die Position). Ein Undo-Schritt. */
export function setPageCover(store: WorkspaceStore, id: string, cover: PageCoverValue | undefined): void {
  if (!store.blocks.has(id)) return;
  store.transact(cover ? "Change cover" : "Remove cover", (tx) => tx.update(id, (x) => {
    const props = { ...(x.props ?? {}) };
    if (cover) props.cover = cover as never;
    else {
      delete props.cover;
      if (props.format) {
        const f = { ...props.format };
        delete f.coverPosition;
        props.format = f;
      }
    }
    clean(props, x);
  }));
}

/** Vertikale Lage des Cover-Bilds, 0 (oben) … 1 (unten); Standard 0,5. */
export function setCoverPosition(store: WorkspaceStore, id: string, position: number): void {
  if (!store.blocks.has(id)) return;
  const p = Math.round(Math.min(1, Math.max(0, position)) * 1000) / 1000;
  store.transact("Reposition cover", (tx) => tx.update(id, (x) => {
    const props = { ...(x.props ?? {}) };
    const format: Format = { ...(props.format ?? {}) };
    if (p === 0.5) delete format.coverPosition;
    else format.coverPosition = p;
    props.format = format;
    clean(props, x);
  }));
}

/** Hochgeladenes Bild (Asset) oder Bild-Link als Seiten-Icon, wie Swift `PageIcon.asset` / `.url`. */
export function setPageIconImage(store: WorkspaceStore, id: string, image: { asset: CoverAsset } | { url: string }): void {
  if (!store.blocks.has(id)) return;
  store.transact("Change icon", (tx) => tx.update(id, (x) => {
    x.props = { ...(x.props ?? {}), icon: image as never };
  }));
}

/** Cover einer Seite lesen (unbekannte Formen: `undefined`). */
export function pageCover(store: WorkspaceStore, id: string): PageCoverValue | undefined {
  const c = store.blocks.get(id)?.props?.cover as Record<string, { _0?: unknown }> | undefined;
  if (!c || typeof c !== "object") return undefined;
  if (typeof c.gradient?._0 === "number") return { gradient: { _0: c.gradient._0 } };
  if (typeof c.color?._0 === "string") return { color: { _0: c.color._0 } };
  if (c.asset?._0 && typeof (c.asset._0 as CoverAsset).id === "string") return { asset: { _0: c.asset._0 as CoverAsset } };
  if (typeof c.url?._0 === "string") return { url: { _0: c.url._0 } };
  return undefined;
}
