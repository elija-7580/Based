/// <reference lib="webworker" />
// Import-Worker: bereitet einen Import vor (entpacken, HTML/Markdown lesen), ohne den Store-Worker zu blockieren.
// Abbrechen beendet ihn (terminate) – das wirkt auch mitten in einer langen, synchronen Vorbereitung.
import { MemoryAssetSink } from "@based/core";
import { prepareFiles } from "./importer.js";
import type { ImportWorkerEvent, ImportWorkerRequest } from "./importClient.js";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (e: MessageEvent<ImportWorkerRequest>) => {
  const post = (m: ImportWorkerEvent) => self.postMessage(m);
  void run(e.data, post).catch((err: unknown) => post({ type: "error", message: err instanceof Error ? err.message : String(err) }));
});

async function run(req: ImportWorkerRequest, post: (m: ImportWorkerEvent) => void) {
  let last = 0;
  // BSD-230: Dateien gehen mit dem Ergebnis zum Store-Worker, der sie über den Sync ablegt (SHA-256, BSD-78).
  const sink = new MemoryAssetSink();
  const payload = prepareFiles(req.files, {
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
