// HTML- und Druck-Export der Shell: eine Seite als eigenständige HTML-Datei (Bilder eingebettet) oder als ZIP
// (Unterseiten in Ordnern, Dateien in `assets/`), der ganze Workspace als ZIP, und die Druckansicht für „PDF“.
// Reine Funktionen über `planWorkspaceExport`; die Bytes der Dateien kommen über `readAsset` (im Browser vorab aus
// dem Asset-Speicher gelesen, siehe `exportAssetRefs`).
import type { Block, BlockProps } from "../model/records.js";
import { titleOf } from "../query/engine.js";
import type { WorkspaceStore } from "../store/store.js";
import { markdownFileName } from "./markdown-export.js";
import { planWorkspaceExport, topLevelPages, writeExportZip, type ExportPlan } from "./workspace-export.js";

type AssetRef = NonNullable<BlockProps["asset"]>;

export interface HTMLExportOptions {
  /** Unterseiten mit exportieren (dann immer ein ZIP). Standard: nein. */
  subpages?: boolean | undefined;
  /** Bilder in die HTML-Datei einbetten (`embed`, Standard) oder alle Dateien als `assets/`-Ordner ins ZIP (`folder`). */
  images?: "embed" | "folder" | undefined;
  /** Stylesheet (aus den Design-Tokens der App); ohne: das eingebaute `EXPORT_CSS`. */
  css?: string | undefined;
  /** Bytes einer Datei oder `undefined`, wenn sie auf diesem Gerät fehlt. */
  readAsset?: ((ref: AssetRef) => Uint8Array | undefined) | undefined;
  date?: Date | undefined;
}

export interface HTMLExportResult {
  /** Dateiname („Seite.html“ oder „Seite.zip“). */
  name: string;
  kind: "html" | "zip";
  data: Uint8Array;
  pages: number;
  /** Eingebettete bzw. beigelegte Dateien. */
  assets: number;
  /** Dateien, die fehlen oder nicht gelesen werden konnten. */
  failures: { path: string; message: string }[];
}

const EMBED_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp" };

/** MIME-Typ, mit dem eine Datei als `data:`-URL eingebettet werden darf (nur Rasterbilder; SVG kann Skripte tragen). */
export function embeddableImageType(ref: AssetRef): string | undefined {
  const mime = ref.mime?.toLowerCase();
  if (mime && mime.startsWith("image/") && !mime.startsWith("image/svg")) return mime;
  const dot = ref.name.lastIndexOf(".");
  return dot < 0 ? undefined : EMBED_MIME[ref.name.slice(dot + 1).toLowerCase()];
}

export function base64Encode(data: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < data.length; i += 3) {
    const n = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
    out += A[n >> 18]! + A[(n >> 12) & 63]! + A[(n >> 6) & 63]! + A[n & 63]!;
  }
  if (i + 1 === data.length) {
    const n = data[i]! << 16;
    out += A[n >> 18]! + A[(n >> 12) & 63]! + "==";
  } else if (i + 2 === data.length) {
    const n = (data[i]! << 16) | (data[i + 1]! << 8);
    out += A[n >> 18]! + A[(n >> 12) & 63]! + A[(n >> 6) & 63]! + "=";
  }
  return out;
}

const fileStem = (title: string) => markdownFileName(title === "" ? "Untitled" : title);

function render(store: WorkspaceStore, pages: Block[], opts: HTMLExportOptions, subpages: boolean, print: boolean): { plan: ExportPlan; embedded: number; failures: HTMLExportResult["failures"] } {
  const failures: HTMLExportResult["failures"] = [];
  const cache = new Map<string, string | undefined>();
  let embedded = 0;
  const embed = (opts.images ?? "embed") === "embed";
  const embedAsset = !embed ? undefined : (ref: AssetRef, page: string): string | undefined => {
    const type = embeddableImageType(ref);
    if (!type) return undefined;
    if (cache.has(ref.id)) return cache.get(ref.id);
    let url: string | undefined;
    let data: Uint8Array | undefined;
    try { data = opts.readAsset?.(ref); } catch { data = undefined; }
    if (data) {
      url = `data:${type};base64,${base64Encode(data)}`;
      embedded += 1;
    } else {
      failures.push({ path: ref.name, message: `“${ref.name}” (on “${page === "" ? "Untitled" : page}”) isn't on this device.` });
      url = "";
    }
    cache.set(ref.id, url);
    return url;
  };
  const plan = planWorkspaceExport(store, pages, "html", { subpages, css: opts.css, print, embedAsset });
  return { plan, embedded, failures };
}

/** Dateien, die ein HTML-Export der Seiten lesen würde (zum Vorab-Laden aus einem asynchronen Speicher). */
export function exportAssetRefs(store: WorkspaceStore, pageIDs: string[], subpages: boolean): AssetRef[] {
  const pages = pageIDs.map((id) => store.blocks.get(id)).filter((b): b is Block => b !== undefined);
  const seen = new Map<string, AssetRef>();
  planWorkspaceExport(store, pages, "html", { subpages, embedAsset: (ref) => { seen.set(ref.id, ref); return ""; } });
  return [...seen.values()];
}

function finish(stem: string, r: ReturnType<typeof render>, opts: HTMLExportOptions, forceZip: boolean): HTMLExportResult {
  const { plan } = r;
  if (!forceZip && plan.files.length === 1 && plan.assets.length === 0) {
    return { name: stem + ".html", kind: "html", data: new TextEncoder().encode(plan.files[0]!.contents), pages: 1, assets: r.embedded, failures: r.failures };
  }
  const { zip, report } = writeExportZip(plan, opts.readAsset ?? (() => undefined), opts.date);
  return { name: stem + ".zip", kind: "zip", data: zip, pages: report.pages, assets: report.assets + r.embedded, failures: [...r.failures, ...report.failures] };
}

/**
 * Eine Seite als HTML. Ohne Unterseiten und mit eingebetteten Bildern entsteht eine einzige, eigenständige Datei;
 * mit Unterseiten, mit `images: "folder"` oder mit Anhängen, die sich nicht einbetten lassen (Video, PDF, Dateien),
 * ein ZIP mit `assets/`.
 */
export function exportPageHTML(store: WorkspaceStore, pageID: string, opts: HTMLExportOptions = {}): HTMLExportResult {
  const page = store.blocks.get(pageID);
  if (!page) throw new Error("This page doesn't exist.");
  const r = render(store, [page], opts, opts.subpages === true, false);
  return finish(fileStem(titleOf(store, pageID)), r, opts, false);
}

/** Der ganze Workspace als HTML-ZIP (Unterseiten in Ordnern, Dateien in `assets/` oder Bilder eingebettet). */
export function exportWorkspaceHTML(store: WorkspaceStore, opts: HTMLExportOptions = {}): HTMLExportResult {
  const r = render(store, topLevelPages(store), { ...opts, images: opts.images ?? "folder" }, true, false);
  return finish("Based Export HTML", r, opts, true);
}

/**
 * Druckansicht einer Seite: ein HTML-Dokument mit eingebetteten Bildern und Druck-Regeln, das die Shell in einen
 * unsichtbaren Rahmen lädt und mit `print()` an den Druckdialog gibt („Als PDF sichern“).
 */
export function printPageHTML(store: WorkspaceStore, pageID: string, opts: Pick<HTMLExportOptions, "css" | "readAsset"> = {}): { html: string; title: string; failures: HTMLExportResult["failures"] } {
  const page = store.blocks.get(pageID);
  if (!page) throw new Error("This page doesn't exist.");
  const r = render(store, [page], { ...opts, images: "embed" }, false, true);
  const title = titleOf(store, pageID);
  // Nicht einbettbare Anhänge stehen als Link im Dokument; im Druck fehlen sie ohnehin.
  return { html: r.plan.files[0]?.contents ?? "", title: title === "" ? "Untitled" : title, failures: r.failures };
}
