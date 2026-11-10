/// <reference lib="webworker" />
// Import-Worker: bereitet einen Import vor (entpacken, HTML/Markdown lesen), ohne den Store-Worker zu blockieren.
// Abbrechen beendet ihn (terminate) – das wirkt auch mitten in einer langen, synchronen Vorbereitung.
import { MemoryAssetSink, type ByteSource } from "@based/core";
import { prepareFiles, StreamingAssetSink, type ImportFile } from "./importer.js";
import type { ImportWorkerEvent, ImportWorkerRequest } from "./importClient.js";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (e: MessageEvent<ImportWorkerRequest>) => {
  const post = (m: ImportWorkerEvent) => self.postMessage(m);
  void run(e.data, post).catch((err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
});

async function run(req: ImportWorkerRequest, post: (m: ImportWorkerEvent) => void) {
  let last = 0;
  // BSD-230: Dateien gehen zum Store-Worker, der sie über den Sync ablegt (SHA-256, BSD-78). BSD-254: einzeln und
  // sofort (Kopie, übertragen), damit der Import-Worker sie nicht bis zum Ende hält.
  const sink = req.stream
    ? new StreamingAssetSink((a) => {
      const data = a.data.slice();
      self.postMessage({ type: "asset", asset: { ...a, data } } satisfies ImportWorkerEvent, [data.buffer]);
    })
    : new MemoryAssetSink();
  const files: ImportFile[] = req.files.map((f) => (f.blob ? { path: f.path, source: blobSource(f.blob) } : { path: f.path, data: f.data! }));
  const payload = prepareFiles(files, {
    progress: (f) => {
      // höchstens ~100 Meldungen
      if (f - last >= 0.01 || f >= 1) { last = f; post({ type: "progress", fraction: f }); }
    },
    assets: sink,
  });
  // Eigene Kopien (Ausschnitte großer ZIP-Puffer), damit sie ohne Kopieren übertragen werden können.
  for (const f of payload.files ?? []) f.data = f.data.slice();
  self.postMessage({ type: "done", payload } satisfies ImportWorkerEvent, [...new Set((payload.files ?? []).map((f) => f.data.buffer as ArrayBuffer))]);
}

/** BSD-254: Bereiche einer gewählten Datei synchron lesen (FileReaderSync gibt es in Dedicated Workern). */
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
