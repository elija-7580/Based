// Hauptthread-Seite des Imports: Dateien lesen, im Import-Worker vorbereiten (Fortschritt, Abbrechen), dann im
// Store-Worker schreiben (`StoreClient.commitImport`).
import type { ImportPayload, StreamedAsset } from "./importer.js";

/** Eine gewählte Datei: als `Blob` (BSD-254: der Worker liest nur, was er braucht) oder schon gelesen (Tests). */
export type ImportRequestFile = { path: string; blob: Blob; data?: undefined } | { path: string; data: Uint8Array; blob?: undefined };
export type ImportWorkerRequest = { files: ImportRequestFile[]; stream?: boolean };
export type ImportWorkerEvent =
  | { type: "progress"; fraction: number }
  /** BSD-254: eine Datei für den Asset-Speicher, sofort (nicht erst mit dem Ergebnis). */
  | { type: "asset"; asset: StreamedAsset }
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

/**
 * Import im Worker vorbereiten. `cancel()` beendet den Worker sofort. `onAsset` (BSD-254): Dateien gehen einzeln
 * weiter (Store-Worker); das Ergebnis kommt erst, wenn alle angekommen sind. Ohne: sie stehen in `payload.files`.
 */
export function prepareInWorker(files: ImportRequestFile[], onProgress: (f: number) => void, make: () => ImportWorkerLike = createImportWorker,
  onAsset?: (a: StreamedAsset) => Promise<unknown>): PreparingImport {
  const worker = make();
  let settle: { resolve: (p: ImportPayload) => void; reject: (e: Error) => void } | undefined;
  const result = new Promise<ImportPayload>((resolve, reject) => (settle = { resolve, reject }));
  const finish = (fn: () => void) => {
    if (!settle) return;
    fn();
    settle = undefined;
    worker.terminate();
  };
  const forwarded: Promise<boolean>[] = [];
  worker.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "progress") { if (settle) onProgress(m.fraction); }
    else if (m.type === "asset") {
      if (settle && onAsset) forwarded.push(onAsset(m.asset).then(() => true, () => false));
    } else if (m.type === "done") {
      const payload = m.payload;
      void Promise.all(forwarded).then((ok) => {
        const failed = ok.filter((x) => !x).length;
        if (failed > 0) payload.notes.push(`${failed} attached file${failed === 1 ? "" : "s"} couldn't be saved (storage full or blocked) and will show as missing.`);
        finish(() => settle!.resolve(payload));
      });
    } else finish(() => settle!.reject(new Error(m.message)));
  });
  const transfer = [...new Set(files.flatMap((f) => (f.data ? [f.data.buffer as ArrayBuffer] : [])))];
  // Mit onAsset streamt der Worker die Dateien (Flag in der Anfrage).
  worker.postMessage({ files, ...(onAsset ? { stream: true } : {}) } as ImportWorkerRequest, transfer);
  return { result, cancel: () => finish(() => settle!.reject(new ImportCancelledError())) };
}

/**
 * Gewählte Dateien; Pfade aus einem Ordner (`webkitRelativePath`) bleiben erhalten. BSD-254: nicht lesen – der
 * Import-Worker liest aus dem `File` nur, was er braucht (ein 750-MB-Export liegt nie ganz im Speicher).
 */
export async function readFiles(list: Iterable<File>): Promise<ImportRequestFile[]> {
  const out: ImportRequestFile[] = [];
  for (const f of list) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    out.push({ path: rel || f.name, blob: f });
  }
  return out;
}
