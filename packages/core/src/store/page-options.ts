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
