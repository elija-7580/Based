/// <reference lib="webworker" />
// BSD-317: Hybrid-Notion-Import im eigenen Worker. Hier wird nur gerechnet (ZIP-Verzeichnis, HTML übersetzen, API-Antworten
// umrechnen – alles in packages/core, notion-hybrid). Drei Dinge laufen über den Hauptthread, weil es sie nur dort gibt:
// HTTP (Tauri-HTTP, kein CORS), der Store-Worker (schreiben, Warteschlange) und die Ablage des Stands. Dateien gehen
// einzeln hinaus und sind bestätigt, bevor ein Schritt geschrieben wird, der auf sie zeigt.
import {
  DEFAULT_MAX_ASSET_BYTES, HybridImportError, HybridNotionImport, LimitedAssetSink, NotionClient, hybridDiagnosticReport, openNotionExport,
  type ByteSource, type HybridProgress, type HybridTarget, type NotionExportIndex, type NotionResponse, type NotionTransport,
} from "@based/core";
import { StreamingAssetSink } from "./importer.js";
import type { HybridWorkerEvent, HybridWorkerRequest } from "./notionHybridClient.js";

declare const self: DedicatedWorkerGlobalScope;

const post = (ev: HybridWorkerEvent, transfer: Transferable[] = []) => self.postMessage(ev, transfer);
const http = new Map<number, { resolve: (r: NotionResponse) => void; reject: (e: Error) => void }>();
const rpcs = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const acks = new Map<number, () => void>();
let nextID = 1;
let cancelled = false;
let job: HybridNotionImport | undefined;
const abort = new AbortController();

const proxy: NotionTransport = {
  send(method, url, headers, body) {
    return new Promise<NotionResponse>((resolve, reject) => {
      const id = nextID++;
      http.set(id, { resolve, reject });
      post({ type: "http", id, method, url, headers, ...(body !== undefined ? { body } : {}) });
    });
  },
};

const rpc = <T,>(method: "commitStructure" | "pending" | "commitContent" | "loadState" | "saveState", arg?: unknown): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const id = nextID++;
    rpcs.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ type: "rpc", id, method, arg });
  });

/** Dateien, die unterwegs zum Store-Worker sind. */
let inFlight: Promise<void>[] = [];
const settled = async () => { const list = inFlight; inFlight = []; await Promise.all(list); };

const target: HybridTarget = {
  commitStructure: async (wire) => { await settled(); return rpc("commitStructure", wire); },
  pending: () => rpc("pending"),
  commitContent: async (batch) => { await settled(); return rpc("commitContent", batch); },
  loadState: () => rpc("loadState"),
  saveState: (s) => rpc("saveState", s),
};

/** Bereiche der gewählten Datei synchron lesen (FileReaderSync gibt es in Dedicated Workern). */
function blobSource(blob: Blob): ByteSource {
  const reader = new FileReaderSync();
  return {
    size: blob.size,
    read: (offset, length) => {
      if (offset < 0 || offset + length > blob.size) throw new RangeError("read past end");
      return new Uint8Array(reader.readAsArrayBuffer(blob.slice(offset, offset + length)));
    },
  };
}

self.addEventListener("message", (e: MessageEvent<HybridWorkerRequest>) => {
  const m = e.data;
  switch (m.type) {
    case "http": {
      const w = http.get(m.id);
      if (!w) return;
      http.delete(m.id);
      if (m.error !== undefined) w.reject(new TypeError(m.error));
      else w.resolve({ status: m.status ?? 0, headers: m.headers ?? {}, body: m.body ?? new Uint8Array(0) });
      return;
    }
    case "rpc": {
      const w = rpcs.get(m.id);
      if (!w) return;
      rpcs.delete(m.id);
      if (m.error !== undefined) w.reject(new Error(m.error)); else w.resolve(m.result);
      return;
    }
    case "ack": acks.get(m.id)?.(); acks.delete(m.id); return;
    case "prioritize": job?.prioritize(m.pageID); return;
    case "cancel": {
      // Laufende Anfragen sofort beenden (der Hauptthread bricht sie ebenfalls ab) – sonst hinge „Pause“ an der Antwort.
      cancelled = true;
      abort.abort();
      for (const [id, w] of http) { http.delete(id); w.reject(new DOMException("aborted", "AbortError")); }
      return;
    }
    case "start": void start(m); return;
  }
});

async function start(m: Extract<HybridWorkerRequest, { type: "start" }>) {
  const client = new NotionClient(m.token, proxy, { ...(m.baseURL ? { baseURL: m.baseURL } : {}), signal: abort.signal, ...(m.requestsPerSecond !== undefined ? { requestsPerSecond: m.requestsPerSecond } : {}) });
  try {
    let index: NotionExportIndex | undefined;
    if (m.zip) {
      post({ type: "progress", progress: { phase: "structure", fraction: 0, message: "Reading the export…", done: 0, total: 0 } });
      index = openNotionExport(blobSource(m.zip));
    }
    const stream = new StreamingAssetSink((a) => {
      const id = nextID++;
      const data = a.data.slice();
      inFlight.push(new Promise<void>((resolve) => acks.set(id, resolve)));
      post({ type: "asset", id, asset: { ...a, data } }, [data.buffer]);
    });
    const imp = new HybridNotionImport(client, index, target, m.downloadFiles === false ? undefined : new LimitedAssetSink(stream, DEFAULT_MAX_ASSET_BYTES), {
      downloadFiles: m.downloadFiles, zipName: m.zipName, isCancelled: () => cancelled,
      yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    job = imp;
    // Höchstens ~8 Meldungen je Sekunde – aber die letzte kommt immer an (sonst bliebe die Anzeige hinter dem Stand).
    let last = 0;
    let latest: HybridProgress | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      if (!latest) return;
      last = Date.now();
      post({ type: "progress", progress: latest });
      latest = undefined;
    };
    imp.onProgress = (p) => {
      latest = p;
      if (Date.now() - last >= 120) { if (timer !== undefined) clearTimeout(timer); flush(); }
      else timer ??= setTimeout(flush, 120);
    };
    const report = await imp.run(m.mode);
    await settled();
    if (timer !== undefined) clearTimeout(timer);
    flush();
    post({ type: "done", report, diagnostic: hybridDiagnosticReport(report.state, report.remaining) });
  } catch (err) {
    const state = await target.loadState().catch(() => undefined);
    post({ type: "error", message: err instanceof Error ? err.message : String(err), ...(err instanceof HybridImportError ? { kind: err.kind } : {}),
      ...(state ? { diagnostic: hybridDiagnosticReport(state) + `\nError: ${err instanceof Error ? err.message : String(err)}\nRequests: ${client.requestCount}${client.lastFailure ? `\nLast failed request: ${client.lastFailure}` : ""}` } : {}) });
  }
}
