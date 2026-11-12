// BSD-317: Inhalt EINER Seite – aus dem ZIP-Export (schnell, ohne Ratenlimit) oder, wo das ZIP nichts Aktuelles hat,
// gezielt über die API. Beide Wege liefern dieselbe Form: die Blöcke unter der Seite, mit Platzhaltern (`page`,
// `databaseInline`) an den Stellen, an denen Unterseiten und Datenbanken stehen. `commitHybridContent` setzt sie ein.
import type { BlockProps } from "../../model/records.js";
import { ImportBuilder, type AssetSink, type ImportBuilderWire } from "../builder.js";
import { NotionHTMLImporter } from "../notion-html.js";
import type { NotionClient } from "../notion-api/client.js";
import { NotionCrawler } from "../notion-api/crawler.js";
import { mapNotionSnapshot } from "../notion-api/mapper.js";
import type { NotionExportIndex } from "./export-index.js";
import type { HybridSource } from "./structure.js";

export interface HybridPageContent {
  pageID: string;
  source: HybridSource;
  /** Die Seite selbst (nur als Träger von Titel/Format aus dem ZIP) und ihre Blöcke in Dokumentreihenfolge. */
  builder: ImportBuilderWire;
  /** Titel laut ZIP (zum Abgleich mit der API). */
  title?: string;
  /** Seitenformat, das nur der Export kennt (Schrift, volle Breite, kleine Schrift, Cover-Position). */
  format?: BlockProps["format"];
  /** Die Datei war nicht lesbar: die Seite bleibt offen und wird über die API geholt. */
  failed?: string;
  /** Die Seite gibt es in Notion nicht mehr (oder sie ist nicht mehr geteilt): nicht noch einmal versuchen. */
  gone?: boolean;
  warnings: string[];
}

const plain = (t: unknown): string => (typeof t === "string" ? t : Array.isArray(t) ? t.map((r: { t?: string }) => r.t ?? "").join("") : "");

/** Liest den Inhalt einer Seite aus dem Export. `undefined`, wenn das ZIP die Seite nicht hat. */
export function readZipPageContent(index: NotionExportIndex, pageID: string, opts: { assets?: AssetSink | undefined; now?: (() => number) | undefined } = {}): HybridPageContent | undefined {
  const file = index.pageFile(pageID);
  if (file === undefined) return undefined;
  const builder = new ImportBuilder({ createdBy: null, now: opts.now });
  const out: HybridPageContent = { pageID, source: "zip", builder: builder.toWire(), warnings: [] };
  try {
    const imp = new NotionHTMLImporter(builder, index.files, { shallow: true });
    const got = imp.importPageShallow(file);
    if (got === undefined) {
      // Ganzseitige Datenbank oder unlesbar: kein Seiteninhalt aus dem ZIP.
      if (builder.warnings.length > 0) out.failed = builder.warnings.join("; ");
      return out;
    }
    const page = builder.block(pageID);
    if (page) {
      const t = plain(page.text);
      if (t !== "") out.title = t;
      if (page.props?.format) out.format = page.props.format;
    }
    if (opts.assets) builder.resolveAssets(opts.assets);
    out.warnings = [...builder.warnings];
    out.builder = builder.toWire();
  } catch (e) {
    out.failed = e instanceof Error ? e.message : String(e);
  } finally {
    index.release();
  }
  return out;
}

/** Holt den Inhalt einer Seite über die API (`blocks/{id}/children`, mit verschachtelten Blöcken; ohne Unterseiten). */
export async function fetchApiPageContent(client: NotionClient, pageID: string, opts: { assets?: AssetSink | undefined; downloadFiles?: boolean | undefined; now?: (() => number) | undefined } = {}): Promise<HybridPageContent> {
  const crawler = new NotionCrawler(client, { rowContent: false, followRelations: false, downloadFiles: opts.downloadFiles ?? true, subpages: false, maxConcurrent: 3, followDatabases: false, strict: true });
  const snap = await crawler.crawlContent([pageID]);
  const failed = snap.warnings.find((w) => w.startsWith(`Content of ${pageID}`));
  // Der Mapper braucht die Seite als Träger; ihre Eigenschaften hat die Struktur schon geschrieben.
  snap.pages.set(pageID, { object: "page", id: pageID, properties: {} });
  snap.roots = [{ page: pageID }];
  const builder = new ImportBuilder({ createdBy: null, now: opts.now });
  mapNotionSnapshot(snap, builder);
  if (opts.assets) builder.resolveAssets(opts.assets);
  // Datenbanken im Inhalt sind hier nur Platzhalter; dass sie „nicht gelesen“ wurden, ist kein Befund.
  const warnings = builder.warnings.filter((w) => !w.startsWith("Database “") && w !== failed);
  const out: HybridPageContent = { pageID, source: "api", builder: builder.toWire(), warnings };
  if (failed !== undefined || !snap.children.has(pageID)) {
    // Mit `strict` bleibt hier nur „nicht gefunden / nicht mehr geteilt“ – erneutes Holen hilft nicht.
    out.failed = failed ?? `Content of ${pageID} couldn't be read`;
    out.gone = true;
  }
  return out;
}
