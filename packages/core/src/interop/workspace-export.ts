// „Alles exportieren“ (BSD-67): Seiten als Markdown oder HTML, Datenbanken als CSV bzw. HTML-Tabellen, Unterseiten in
// einem Ordner wie die Datei ihrer Elternseite (Struktur des Notion-Exports), dazu jedes Bild, Video und jeder Anhang in
// `assets/`. Port von Swift Interop/WorkspaceExporter.swift.
//
// `planWorkspaceExport` rendert alles (rein, liest nur den Store); `writeExportZip` packt den Plan mit den Dateien aus
// einem Asset-Lesezugriff in ein ZIP und meldet jede Datei, die fehlt. Dateinamen sind je Ordner eindeutig
// („Notes.md“, „Notes (2).md“, ohne Groß/klein wie APFS), Links relativ und prozentkodiert.
import type { Block, BlockProps } from "../model/records.js";
import { titleOf } from "../query/engine.js";
import type { WorkspaceStore } from "../store/store.js";
import { HTMLExporter } from "./export.js";
import { exportHTMLPage } from "./html-document.js";
import { encodeURLPath, MarkdownExporter, markdownFileName } from "./markdown-export.js";
import { writeZip, type ZipWriteEntry } from "./zip.js";

type AssetRef = NonNullable<BlockProps["asset"]>;
export type ExportFormat = "markdown" | "html";

export const ASSETS_FOLDER = "assets";

export interface ExportPlan {
  directories: string[];
  files: { path: string; contents: string }[];
  /** Dateien für `assets/`: Pfad im Export, Verweis, Titel der ersten Seite, die sie nutzt. */
  assets: { path: string; ref: AssetRef; name: string; page: string }[];
}

export interface ExportReport {
  pages: number;
  assets: number;
  failures: { path: string; message: string }[];
}

const join = (dir: string, name: string) => (dir === "" ? name : dir + "/" + name);
export const exportDirectory = (path: string) => { const i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); };

/** `to` relativ zum Ordner `dir` („A/B“ → „A/C/x.md“ = „../C/x.md“). */
export function relativeExportPath(dir: string, path: string): string {
  const a = dir.split("/").filter(Boolean), b = path.split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length - 1 && a[common] === b[common]) common++;
  return [...Array<string>(a.length - common).fill(".."), ...b.slice(common)].join("/");
}

/** Prozentkodiert jeden Pfadteil, auch Klammern („Notes (2).md“ bleibt ein gültiger Markdown-Link). */
export const encodeExportPath = (path: string) => path.split("/").map((p) => encodeURLPath(p, "()")).join("/");

/** „Name“, dann „Name (2)“ … – eindeutig ohne Groß/klein innerhalb `used` (wird ergänzt). */
export function uniqueExportName(stem: string, used: Set<string>, ext = ""): string {
  const make = (n: number) => { const s = n === 1 ? stem : `${stem} (${n})`; return ext === "" ? s : s + "." + ext; };
  let n = 1;
  while (used.has(make(n).toLowerCase())) n++;
  const name = make(n);
  used.add(name.toLowerCase());
  return name;
}

const isPageLike = (b: Block) => b.type === "page" || b.type === "databasePage";
const ownsDatabase = (store: WorkspaceStore, b: Block) => b.props?.databaseID !== undefined && store.databases.get(b.props.databaseID)?.blockID === b.id;
const contentBlocks = (store: WorkspaceStore, id: string) =>
  store.children("b:" + id).map((k) => store.blocks.get(k)).filter((b): b is Block => b !== undefined && b.trashedAt === undefined);

/** Seiten und Datenbanken im Inhalt einer Seite (beliebig tief, nicht in andere Seiten hinein). */
export function subpages(store: WorkspaceStore, id: string): Block[] {
  const out: Block[] = [];
  const walk = (pid: string) => {
    for (const c of contentBlocks(store, pid)) {
      if (isPageLike(c) || (c.type === "databaseInline" && ownsDatabase(store, c))) out.push(c);
      else if (c.type !== "syncedBlock" || c.props?.syncSource === undefined) walk(c.id);
    }
  };
  walk(id);
  return out;
}

/** Seiten der obersten Ebene (ohne Papierkorb). */
export function topLevelPages(store: WorkspaceStore): Block[] {
  const seen = new Set<string>();
  return store.children("w").map((id) => store.blocks.get(id)).filter((b): b is Block =>
    b !== undefined && b.trashedAt === undefined && isPageLike(b) && !seen.has(b.id) && (seen.add(b.id), true));
}

/** Swift `HTMLExporter`-Standard: Links auf „<Titel>.html“ daneben. */
export const defaultHTMLPageLink = (store: WorkspaceStore) => (id: string) => {
  const t = titleOf(store, id);
  return { title: t, url: encodeURLPath(markdownFileName(t) + ".html") };
};

/** Rendert `pages` und ihre Unterseiten (rekursiv) in einen Plan (Swift `WorkspaceExporter.plan`). */
export function planWorkspaceExport(store: WorkspaceStore, pages: Block[], format: ExportFormat): ExportPlan {
  // Durchgang 1: ein eindeutiger Pfad je Seite, damit Links stimmen.
  const paths = new Map<string, string>();
  const order: string[] = [];
  const used = new Map<string, Set<string>>([["", new Set([ASSETS_FOLDER])]]);
  const directories: string[] = [];
  const assign = (page: Block, dir: string) => {
    if (paths.has(page.id)) return;
    const isDB = page.type === "databasePage" || page.type === "databaseInline";
    const ext = format === "html" ? "html" : isDB ? "csv" : "md";
    let set = used.get(dir);
    if (!set) used.set(dir, (set = new Set()));
    const base = uniqueExportName(markdownFileName(titleOf(store, page.id)), set);
    paths.set(page.id, join(dir, base + "." + ext));
    order.push(page.id);
    const kids = subpages(store, page.id);
    if (kids.length === 0) return;
    const sub = join(dir, base);
    directories.push(sub);
    for (const k of kids) assign(k, sub);
  };
  for (const p of pages) assign(p, "");

  // Durchgang 2: rendern, Links relativ zur jeweiligen Datei.
  const assetPaths = new Map<string, string>();
  const assetsUsed = new Set<string>();
  const assets: ExportPlan["assets"] = [];
  const assetPath = (ref: AssetRef, page: string) => {
    const known = assetPaths.get(ref.id);
    if (known !== undefined) return known;
    const name = markdownFileName(ref.name);
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : "";
    const stem = ext === "" ? name : name.slice(0, -(ext.length + 1));
    const path = join(ASSETS_FOLDER, uniqueExportName(stem === "" ? "file" : stem, assetsUsed, ext));
    assetPaths.set(ref.id, path);
    assets.push({ path, ref, name: ref.name, page });
    return path;
  };
  const files: ExportPlan["files"] = [];
  for (const id of order) {
    const page = store.blocks.get(id), path = paths.get(id);
    if (!page || path === undefined) continue;
    const dir = exportDirectory(path);
    const pageLink = (target: string) => {
      const t = titleOf(store, target);
      const to = paths.get(target);
      // Nicht Teil des Exports: der schlichte Notion-Name.
      if (to === undefined) return { title: t, url: encodeExportPath(markdownFileName(t) + (format === "html" ? ".html" : ".md")) };
      return { title: t, url: encodeExportPath(relativeExportPath(dir, to)) };
    };
    const assetLink = (ref: AssetRef) => encodeExportPath(relativeExportPath(dir, assetPath(ref, titleOf(store, id))));
    let text: string;
    if (format === "html") {
      text = exportHTMLPage(new HTMLExporter(store, { pageLink, assetLink }), id);
    } else {
      const e = new MarkdownExporter(store, { pageLink, assetLink });
      if (page.type === "databasePage" || page.type === "databaseInline") {
        const db = page.props?.databaseID !== undefined ? store.databases.get(page.props.databaseID) : undefined;
        text = db ? e.csv(db.id) : "";
      } else text = e.export(id);
    }
    files.push({ path, contents: text });
  }
  if (assets.length > 0) directories.push(ASSETS_FOLDER);
  return { directories, files, assets };
}

/**
 * Packt einen Plan als ZIP. `readAsset` liefert die Bytes einer Datei oder `undefined`, wenn sie auf diesem Gerät fehlt –
 * das wird gemeldet, nicht abgebrochen (Swift `ExportPlan.write`).
 */
export function writeExportZip(plan: ExportPlan, readAsset: (ref: AssetRef) => Uint8Array | undefined, date?: Date): { zip: Uint8Array; report: ExportReport } {
  const report: ExportReport = { pages: 0, assets: 0, failures: [] };
  const entries: ZipWriteEntry[] = [];
  const enc = new TextEncoder();
  for (const f of plan.files) { entries.push({ path: f.path, data: enc.encode(f.contents) }); report.pages += 1; }
  for (const a of plan.assets) {
    let data: Uint8Array | undefined;
    try { data = readAsset(a.ref); } catch (e) {
      report.failures.push({ path: a.path, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!data) {
      report.failures.push({ path: a.path, message: `“${a.name}” (on “${a.page === "" ? "Untitled" : a.page}”) isn't on this device yet — open the page once so it downloads, then export again.` });
      continue;
    }
    entries.push({ path: a.path, data });
    report.assets += 1;
  }
  return { zip: writeZip(entries, date), report };
}

/** Die Zeile, die die App zeigt (Swift `ExportReport.summary`). */
export function exportSummary(r: ExportReport, directory: string): string {
  let s = `Exported ${r.pages} page${r.pages === 1 ? "" : "s"}`;
  if (r.assets > 0) s += ` and ${r.assets} file${r.assets === 1 ? "" : "s"}`;
  s += ` to ${directory}.`;
  if (r.failures.length > 0) {
    s += ` ${r.failures.length} problem${r.failures.length === 1 ? "" : "s"}: ` + r.failures.slice(0, 3).map((f) => `${f.path} — ${f.message}`).join("; ");
    if (r.failures.length > 3) s += "; …";
  }
  return s;
}
