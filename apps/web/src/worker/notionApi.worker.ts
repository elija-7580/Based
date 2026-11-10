/// <reference lib="webworker" />
// BSD-217 Teil 2: Notion-API-Import im eigenen Worker – holen und übersetzen (packages/core, notion-api), ohne die
// Oberfläche oder den Store-Worker zu blockieren. Das HTTP macht der Hauptthread (Tauri-HTTP gibt es nur dort; im
// Worker gäbe es außerdem CORS): jede Anfrage geht als Nachricht hinaus, die Antwort kommt zurück. Abbrechen beendet
// den Worker. Ergebnis ist dieselbe `ImportPayload` wie beim Datei-Import – geschrieben wird im Store-Worker
// (`commitImport`, mit Reimport-Schutz BSD-32).
import { DEFAULT_MAX_ASSET_BYTES, LimitedAssetSink, NotionWorkspaceImport, preparedImportToWire, type NotionResponse, type NotionTransport } from "@based/core";
import { StreamingAssetSink, type ImportPayload } from "./importer.js";
import type { NotionWorkerEvent, NotionWorkerRequest } from "./notionApiClient.js";

declare const self: DedicatedWorkerGlobalScope;

const waiting = new Map<number, { resolve: (r: NotionResponse) => void; reject: (e: Error) => void }>();
let nextID = 1;

/** HTTP über den Hauptthread. */
const proxy: NotionTransport = {
  send(method, url, headers, body) {
    return new Promise<NotionResponse>((resolve, reject) => {
      const id = nextID++;
      waiting.set(id, { resolve, reject });
      const m: NotionWorkerEvent = { type: "http", id, method, url, headers, ...(body !== undefined ? { body } : {}) };
      self.postMessage(m);
    });
  },
};

self.addEventListener("message", (e: MessageEvent<NotionWorkerRequest>) => {
  const m = e.data;
  if (m.type === "http") {
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error !== undefined) w.reject(new TypeError(m.error));
    else w.resolve({ status: m.status ?? 0, headers: m.headers ?? {}, body: m.body ?? new Uint8Array(0) });
    return;
  }
  const post = (ev: NotionWorkerEvent, transfer: Transferable[] = []) => self.postMessage(ev, transfer);
  const imp = new NotionWorkspaceImport(m.token, proxy, { options: m.options, ...(m.baseURL ? { client: { baseURL: m.baseURL } } : {}) });
  let last = -1, lastMessage = "";
  imp.onProgress = (fraction, message) => {
    if (fraction - last < 0.005 && message === lastMessage) return;
    last = fraction;
    lastMessage = message;
    post({ type: "progress", fraction, message });
  };
  void (async () => {
    const builder = await imp.fetch(m.targets);
    const payload: ImportPayload = { notion: undefined, archives: [], notes: [], assets: 0 };
    if (builder.isEmpty) {
      const r = builder.report();
      payload.notes.push(...r.warnings);
      if (r.warnings.length === 0) payload.notes.push("Nothing was imported. Make sure the pages are shared with the integration (••• → Connections).");
    } else {
      // Dateien einzeln an den Store-Worker (BSD-254), nicht gesammelt im Ergebnis.
      const stream = new StreamingAssetSink((a) => {
        const data = a.data.slice();
        post({ type: "asset", asset: { ...a, data } }, [data.buffer]);
      });
      builder.resolveAssets(new LimitedAssetSink(stream, DEFAULT_MAX_ASSET_BYTES));
      payload.assets = stream.count;
      payload.notion = preparedImportToWire({ builder, markdown: undefined, notes: [] });
    }
    const warnings = builder.report().warnings;
    post({ type: "done", payload, report: imp.diagnosticReport(m.targets, undefined, warnings) });
  })().catch((err: unknown) => {
    post({ type: "error", message: err instanceof Error ? err.message : String(err), report: imp.diagnosticReport(m.targets, err, []) });
  });
});
