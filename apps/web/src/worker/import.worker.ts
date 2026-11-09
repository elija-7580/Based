/// <reference lib="webworker" />
// Import-Worker: bereitet einen Import vor (entpacken, HTML/Markdown lesen), ohne den Store-Worker zu blockieren.
// Abbrechen beendet ihn (terminate) – das wirkt auch mitten in einer langen, synchronen Vorbereitung.
import { prepareFiles } from "./importer.js";
import type { ImportWorkerEvent, ImportWorkerRequest } from "./importClient.js";

declare const self: DedicatedWorkerGlobalScope;

self.addEventListener("message", (e: MessageEvent<ImportWorkerRequest>) => {
  const post = (m: ImportWorkerEvent) => self.postMessage(m);
  let last = 0;
  try {
    const payload = prepareFiles(e.data.files, {
      progress: (f) => {
        // höchstens ~100 Meldungen
        if (f - last >= 0.01 || f >= 1) { last = f; post({ type: "progress", fraction: f }); }
      },
    });
    post({ type: "done", payload });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
});
