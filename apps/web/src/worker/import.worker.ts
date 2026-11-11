/// <reference lib="webworker" />
// Import-Worker: bereitet einen Import vor (entpacken, HTML/Markdown lesen), ohne den Store-Worker zu blockieren.
// Abbrechen beendet ihn (terminate) – das wirkt auch mitten in einer langen, synchronen Vorbereitung.
import { MemoryAssetSink, type ByteSource } from "@based/core";
import { drainDeferred, prepareFiles, StreamingAssetSink, type ImportFile } from "./importer.js";
import type { ImportWorkerEvent, ImportWorkerMessage, ImportWorkerRequest } from "./importClient.js";

declare const self: DedicatedWorkerGlobalScope;

/** BSD-283: wartende Dateien → Bestätigung des Hauptthreads (abgelegt oder gescheitert). */
const acks = new Map<string, () => void>();

self.addEventListener("message", (e: MessageEvent<ImportWorkerMessage>) => {
  const m = e.data;
  if ("type" in m && m.type === "ack") {
    acks.get(m.id)?.();
    acks.delete(m.id);
    return;
  }
  const post = (ev: ImportWorkerEvent) => self.postMessage(ev);
  void run(m as ImportWorkerRequest, post).catch((err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
});

async function run(req: ImportWorkerRequest, post: (m: ImportWorkerEvent) => void) {
  let last = 0;
  const report = (f: number) => {
    // höchstens ~100 Meldungen
    if (f - last >= 0.01 || f >= 1) { last = f; post({ type: "progress", fraction: f }); }
  };
  // BSD-230: Dateien gehen zum Store-Worker, der sie über den Sync ablegt (SHA-256, BSD-78). BSD-254: einzeln
  // (Kopie, übertragen), damit der Import-Worker sie nicht bis zum Ende hält. BSD-283: Dateien aus dem Export werden
  // erst nach der Vorbereitung gelesen und nur so schnell, wie der Store-Worker sie ablegt (Gegendruck).
  const sink = req.stream
    ? new StreamingAssetSink((a) => {
      const data = a.data.slice();
      self.postMessage({ type: "asset", asset: { ...a, data } } satisfies ImportWorkerEvent, [data.buffer]);
    }, { lazy: true })
    : new MemoryAssetSink();
  const files: ImportFile[] = req.files.map((f) => (f.blob ? { path: f.path, source: blobSource(f.blob) } : { path: f.path, data: f.data! }));
  const share = sink instanceof StreamingAssetSink ? 0.6 : 1;
  const payload = prepareFiles(files, { progress: (f) => report(f >= 1 && share < 1 ? share : f * share), assets: sink });
  if (sink instanceof StreamingAssetSink && sink.deferred.length > 0) {
    const unreadable = await drainDeferred(sink, (a) => new Promise<void>((resolve) => {
      acks.set(a.id, resolve);
      // Nur einen eigenen Puffer übertragen (ein Ausschnitt würde den ganzen Puffer abkoppeln).
      const own = a.data.byteOffset === 0 && a.data.byteLength === a.data.buffer.byteLength;
      const data = own ? a.data : a.data.slice();
      self.postMessage({ type: "asset", asset: { ...a, data }, ack: true } satisfies ImportWorkerEvent, [data.buffer as ArrayBuffer]);
    }), { progress: (f) => report(share + f * (1 - share)) });
    if (unreadable > 0) payload.notes.push(`${unreadable} attached file${unreadable === 1 ? "" : "s"} couldn't be read and will show as missing.`);
  }
  report(1);
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
