// BSD-217: Import über die öffentliche Notion-API (Port von Swift `NotionWorkspaceImport`): holen, übersetzen,
// in einem rückgängig machbaren Schritt schreiben. Erneuter Import aktualisiert an Ort und Stelle (BSD-32).
// Clean-Room: nur die öffentliche API-Dokumentation. Das Token bleibt in der Hülle (verschlüsselt) und im Transport.
import type { WorkspaceStore } from "../../store/store.js";
import { commitImport, ImportBuilder, type AssetSink, type ImportReport } from "../builder.js";
import { NotionClient, type NotionClientOptions, type NotionTransport } from "./client.js";
import { defaultNotionImportOptions, NotionCrawler, type NotionImportOptions } from "./crawler.js";
import { mapNotionSnapshot } from "./mapper.js";

export * from "./client.js";
export * from "./crawler.js";
export * from "./mapper.js";

export class NotionWorkspaceImport {
  readonly client: NotionClient;
  readonly options: NotionImportOptions;
  /** Fortschritt 0…1 und kurzer Text. */
  onProgress: ((fraction: number, message: string) => void) | undefined;

  constructor(token: string, transport: NotionTransport, opts: { options?: Partial<NotionImportOptions>; client?: NotionClientOptions } = {}) {
    this.client = new NotionClient(token, transport, opts.client);
    this.options = { ...defaultNotionImportOptions(), ...opts.options };
  }

  /** Holt die Ziele (leer = alles Freigegebene) und übersetzt sie. */
  async fetch(targets: readonly string[], builder = new ImportBuilder()): Promise<ImportBuilder> {
    const crawler = new NotionCrawler(this.client, this.options);
    crawler.onProgress = (done, total, message) => this.onProgress?.(Math.min(0.92, (done / Math.max(total, 1)) * 0.92), message);
    const snap = await crawler.crawl(targets);
    this.onProgress?.(0.94, "Converting…");
    mapNotionSnapshot(snap, builder);
    builder.notes.push(`${this.client.requestCount} Notion API requests.`);
    return builder;
  }

  /** Holen, übersetzen und in einem Schritt schreiben. */
  async run(targets: readonly string[], store: WorkspaceStore, assets: AssetSink | undefined, parent = "w", builder?: ImportBuilder): Promise<ImportReport> {
    const b = await this.fetch(targets, builder);
    if (b.isEmpty) {
      const r = b.report();
      if (r.warnings.length === 0) r.warnings.push("Nothing was imported. Make sure the pages are shared with the integration (••• → Connections).");
      return r;
    }
    this.onProgress?.(0.97, "Saving…");
    const stored = b.resolveAssets(assets);
    const report = commitImport(store, b, parent, "Import from Notion");
    report.assets = stored;
    this.onProgress?.(1, "Done");
    return report;
  }

  /** Bericht zum Kopieren: Version, Optionen, Anfragen, letzte fehlgeschlagene Anfrage, Fehler, Warnungen – ohne Token und Inhalte. */
  diagnosticReport(targets: readonly string[], error: unknown, warnings: readonly string[], now = new Date()): string {
    const lines = [
      "Based — Notion API import report",
      `Date: ${now.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
      `Notion-Version: ${NotionClient.version}`,
      `Targets: ${targets.length === 0 ? "everything shared with the integration" : targets.map((t) => t.slice(0, 8) + "…").join(", ")}`,
      `Options: subpages=${this.options.subpages} files=${this.options.downloadFiles}`,
      `Requests: ${this.client.requestCount}`,
    ];
    if (this.client.lastFailure) lines.push(`Last failed request: ${this.client.lastFailure}`);
    if (error !== undefined && error !== null) {
      lines.push(`Error: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.name !== "Error") lines.push(`Error detail: ${error.name}`);
    }
    if (warnings.length > 0) {
      lines.push(`Warnings (${warnings.length}):`);
      lines.push(...warnings.slice(0, 200).map((w) => "  • " + w));
    }
    return lines.join("\n");
  }

  /** Prüft ein Token; liefert Name und Workspace der Integration. */
  static async verify(token: string, transport: NotionTransport, client?: NotionClientOptions): Promise<string> {
    const me = await new NotionClient(token, transport, client).get("users/me");
    const o = me && typeof me === "object" && !Array.isArray(me) ? me : {};
    const name = typeof o.name === "string" ? o.name : "Integration";
    const bot = o.bot && typeof o.bot === "object" && !Array.isArray(o.bot) ? o.bot : {};
    const ws = typeof bot.workspace_name === "string" ? bot.workspace_name : "";
    return ws ? `${name} · ${ws}` : name;
  }
}
