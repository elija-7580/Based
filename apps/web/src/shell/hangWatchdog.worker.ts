// BSD-418: Watchdog-Worker je Tab – pingt den Hauptthread im Takt von 500 ms (nur solange die Seite sichtbar ist).
// Antwortet er länger als 2 s nicht, steht ein Marker in OPFS (sonst IndexedDB; Logik: HangWatchdog in packages/core/src/hangs.ts).
import { HangWatchdog, type WatchdogMessage } from "@based/core/hangs";
import { deleteMarker, openMarkerFile, putMarker } from "./hangMarkers.js";

const TICK_MS = 500;
const scope = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent<WatchdogMessage>) => void) | null };

// Synchroner OPFS-Zugriff (WebKit: IndexedDB im Worker läuft über den Hauptthread und stünde im Hänger still)
let file: Awaited<ReturnType<typeof openMarkerFile>>;
const watchdog = new HangWatchdog({
  now: () => performance.now(),
  epoch: () => Date.now(),
  send: (e) => scope.postMessage(e),
  writeMarker: (m) => { if (file) file.write(m); else void putMarker(m); },
  clearMarker: (s) => { if (file) file.clear(); else void deleteMarker(s); },
});

let timer: ReturnType<typeof setInterval> | undefined;
const run = (on: boolean) => {
  if (on && timer === undefined) timer = setInterval(() => watchdog.tick(), TICK_MS);
  if (!on && timer !== undefined) { clearInterval(timer); timer = undefined; }
};

scope.onmessage = (e) => {
  if (e.data.type === "start") void openMarkerFile(e.data.session).then((f) => { file = f; });
  watchdog.handle(e.data);
  if (e.data.type === "start" || e.data.type === "resume") run(true);
  if (e.data.type === "pause") run(false);
};
