// BSD-217 Teil 2: Hauptthread-Seite des Notion-API-Imports. Startet den Worker, beantwortet seine HTTP-Anfragen über
// den Transport der Hülle (Tauri-HTTP in der Desktop-App, sonst fetch), reicht Dateien einzeln an den Store-Worker
// und liefert am Ende die `ImportPayload` für `StoreClient.commitImport`. `cancel()` bricht laufende Anfragen ab und
// beendet den Worker.
import type { NotionAPIImportOptions as NotionImportOptions, NotionTransport } from "@based/core";
import { ImportCancelledError } from "./importClient.js";
import type { ImportPayload, StreamedAsset } from "./importer.js";

export type NotionWorkerRequest =
  | { type: "start"; token: string; targets: string[]; options: Partial<NotionImportOptions>; baseURL?: string }
  | { type: "http"; id: number; status?: number; headers?: Record<string, string>; body?: Uint8Array; error?: string };

export type NotionWorkerEvent =
  | { type: "http"; id: number; method: string; url: string; headers: Record<string, string>; body?: string }
  | { type: "progress"; fraction: number; message: string }
  | { type: "asset"; asset: StreamedAsset }
  | { type: "done"; payload: ImportPayload; report: string }
  | { type: "error"; message: string; report: string };

export interface NotionWorkerLike {
  postMessage(msg: NotionWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (e: { data: NotionWorkerEvent }) => void): void;
  terminate(): void;
}

export const createNotionWorker = (): NotionWorkerLike =>
  new Worker(new URL("./notionApi.worker.ts", import.meta.url), { type: "module", name: "based-notion-import" }) as unknown as NotionWorkerLike;

/** Fehler des Imports mit dem Diagnosebericht (ohne Token und Inhalte) zum Kopieren. */
export class NotionImportError extends Error {
  constructor(message: string, readonly report: string) {
    super(message);
    this.name = "NotionImportError";
  }
}

export interface NotionImportJob {
  result: Promise<{ payload: ImportPayload; report: string }>;
  cancel(): void;
}

export interface NotionImportStart {
  token: string;
  targets: string[];
  options?: Partial<NotionImportOptions>;
  baseURL?: string | undefined;
  transport: NotionTransport;
  onProgress?: (fraction: number, message: string) => void;
  /** Dateien einzeln ablegen (Store-Worker); das Ergebnis wartet, bis alle angekommen sind. */
  onAsset?: (a: StreamedAsset) => Promise<unknown>;
  make?: () => NotionWorkerLike;
}

export function runNotionImport(s: NotionImportStart): NotionImportJob {
  const worker = (s.make ?? createNotionWorker)();
  const abort = new AbortController();
  let settle: { resolve: (r: { payload: ImportPayload; report: string }) => void; reject: (e: Error) => void } | undefined;
  const result = new Promise<{ payload: ImportPayload; report: string }>((resolve, reject) => (settle = { resolve, reject }));
  const finish = (fn: () => void) => {
    if (!settle) return;
    fn();
    settle = undefined;
    abort.abort();
    worker.terminate();
  };
  const forwarded: Promise<boolean>[] = [];
  worker.addEventListener("message", (e) => {
    const m = e.data;
    switch (m.type) {
      case "http":
        void s.transport.send(m.method, m.url, m.headers, m.body, abort.signal).then(
          (r) => {
            if (!settle) return;
            // Eigene Kopie, damit der Puffer übertragen werden kann (der Transport darf seinen behalten).
            const body = r.body.byteOffset === 0 && r.body.byteLength === r.body.buffer.byteLength ? r.body : r.body.slice();
            worker.postMessage({ type: "http", id: m.id, status: r.status, headers: r.headers, body }, [body.buffer as ArrayBuffer]);
          },
          (err: unknown) => {
            if (settle) worker.postMessage({ type: "http", id: m.id, error: err instanceof Error ? err.message : String(err) });
          },
        );
        break;
      case "progress": if (settle) s.onProgress?.(m.fraction, m.message); break;
      case "asset": if (settle && s.onAsset) forwarded.push(s.onAsset(m.asset).then(() => true, () => false)); break;
      case "done": {
        const { payload, report } = m;
        void Promise.all(forwarded).then((ok) => {
          const failed = ok.filter((x) => !x).length;
          if (failed > 0) payload.notes.push(`${failed} attached file${failed === 1 ? "" : "s"} couldn't be saved (storage full or blocked) and will show as missing.`);
          finish(() => settle!.resolve({ payload, report }));
        });
        break;
      }
      case "error": finish(() => settle!.reject(new NotionImportError(m.message, m.report))); break;
    }
  });
  worker.postMessage({ type: "start", token: s.token, targets: s.targets, options: s.options ?? {}, ...(s.baseURL ? { baseURL: s.baseURL } : {}) });
  return { result, cancel: () => finish(() => settle!.reject(new ImportCancelledError())) };
}
