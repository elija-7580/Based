/// <reference lib="webworker" />
// Import-Worker: bereitet einen Import vor (entpacken, HTML/Markdown lesen), ohne den Store-Worker zu blockieren.
// Abbrechen beendet ihn (terminate) – das wirkt auch mitten in einer langen, synchronen Vorbereitung.
import { MemoryAssetSink } from "@based/core";
import { IDBAssetStore } from "./assets.js";
import { prepareFiles } from "./importer.js";
import type { ImportWorkerEvent, ImportWorkerRequest } from "./importClient.js";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (e: MessageEvent<ImportWorkerRequest>) => {
  const post = (m: ImportWorkerEvent) => self.postMessage(m);
  void run(e.data, post).catch((err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
});

async function run(req: ImportWorkerRequest, post: (m: ImportWorkerEvent) => void) {
  let last = 0;
  // Bilder und Anhänge nur übernehmen, wenn der Asset-Speicher (IndexedDB) da ist – sonst zeigten Blöcke ins Leere.
  const store = new IDBAssetStore();
  const sink = (await store.available()) ? new MemoryAssetSink() : undefined;
  const payload = prepareFiles(req.files, {
    progress: (f) => {
      // höchstens ~100 Meldungen
      if (f - last >= 0.01 || f >= 1) { last = f; post({ type: "progress", fraction: f }); }
    },
    ...(sink ? { assets: sink } : {}),
  });
  if (sink) {
    let failed = 0;
    for (const [id, f] of sink.files) {
      try {
        await store.put(id, { data: f.data, name: f.ref.name, ...(f.ref.mime ? { mime: f.ref.mime } : {}) });
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) payload.notes.push(`${failed} attached file${failed === 1 ? "" : "s"} couldn't be saved in this browser (storage full or blocked) and will show as missing.`);
  }
  post({ type: "done", payload });
}
