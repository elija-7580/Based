// Hauptthread-Seite des Imports: Dateien lesen, im Import-Worker vorbereiten (Fortschritt, Abbrechen), dann im
// Store-Worker schreiben (`StoreClient.commitImport`).
import type { ImportFile, ImportPayload } from "./importer.js";

export type ImportWorkerRequest = { files: ImportFile[] };
export type ImportWorkerEvent =
  | { type: "progress"; fraction: number }
  | { type: "done"; payload: ImportPayload }
  | { type: "error"; message: string };

/** Was der Import vom Worker braucht (echter Worker oder ein Test-Doppel). */
export interface ImportWorkerLike {
  postMessage(msg: ImportWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (e: { data: ImportWorkerEvent }) => void): void;
  terminate(): void;
}

export class ImportCancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "ImportCancelledError";
  }
}

export interface PreparingImport {
  result: Promise<ImportPayload>;
  cancel(): void;
}

export const createImportWorker = (): ImportWorkerLike =>
  new Worker(new URL("./import.worker.ts", import.meta.url), { type: "module", name: "based-import" }) as unknown as ImportWorkerLike;

/** Import im Worker vorbereiten. `cancel()` beendet den Worker sofort. */
export function prepareInWorker(files: ImportFile[], onProgress: (f: number) => void, make: () => ImportWorkerLike = createImportWorker): PreparingImport {
  const worker = make();
  let settle: { resolve: (p: ImportPayload) => void; reject: (e: Error) => void } | undefined;
  const result = new Promise<ImportPayload>((resolve, reject) => (settle = { resolve, reject }));
  const finish = (fn: () => void) => {
    if (!settle) return;
    fn();
    settle = undefined;
    worker.terminate();
  };
  worker.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "progress") { if (settle) onProgress(m.fraction); }
    else if (m.type === "done") finish(() => settle!.resolve(m.payload));
    else finish(() => settle!.reject(new Error(m.message)));
  });
  worker.postMessage({ files }, [...new Set(files.map((f) => f.data.buffer as ArrayBuffer))]);
  return { result, cancel: () => finish(() => settle!.reject(new ImportCancelledError())) };
}

/** Gewählte Dateien lesen; Pfade aus einem Ordner (`webkitRelativePath`) bleiben erhalten. */
export async function readFiles(list: Iterable<File>): Promise<ImportFile[]> {
  const out: ImportFile[] = [];
  for (const f of list) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    out.push({ path: rel || f.name, data: new Uint8Array(await f.arrayBuffer()) });
  }
  return out;
}
