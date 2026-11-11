/// <reference lib="webworker" />
// Graph-Layout im Worker: das Kraft-Layout (ForceLayout aus @based/core) rechnet hier in Häppchen von ~12 ms und
// schickt nach jedem Häppchen die Positionen; der Hauptthread zeichnet nur. So bleibt die Oberfläche auch bei 5.000
// Knoten flüssig, egal wie lange ein Schritt dauert.
import { ForceLayout } from "@based/core";
import type { LayoutWorkerEvent, LayoutWorkerRequest } from "./layoutClient.js";

declare const self: DedicatedWorkerGlobalScope;

let layout: ForceLayout | undefined;
let generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const post = (m: LayoutWorkerEvent, transfer: Transferable[] = []) => self.postMessage(m, transfer);

function send() {
  const l = layout;
  if (!l) return;
  const x = l.x.slice(), y = l.y.slice();
  post({ type: "positions", generation, x, y, settled: l.settled, steps: l.steps }, [x.buffer, y.buffer]);
}

function loop() {
  timer = undefined;
  const l = layout;
  if (!l || l.settled) return;
  l.run(12);
  send();
  // kurze Pause: der Worker soll dem Hauptthread auf schwachen Geräten nicht den ganzen Kern nehmen
  if (!l.settled) timer = setTimeout(loop, 4);
}

function kick() {
  if (timer === undefined) timer = setTimeout(loop, 0);
}

self.addEventListener("message", (e: MessageEvent<LayoutWorkerRequest>) => {
  const m = e.data;
  if (m.type === "start") {
    generation = m.generation;
    const initial = new Map<string, { x: number; y: number }>();
    if (m.initial) for (let i = 0; i < m.initial.ids.length; i++) initial.set(m.initial.ids[i]!, { x: m.initial.x[i]!, y: m.initial.y[i]! });
    layout = new ForceLayout(m.ids, m.links, m.alpha !== undefined ? { alpha: m.alpha } : {}, initial.size ? initial : undefined);
    send();
    kick();
  } else if (m.type === "pin" && layout && m.generation === generation) {
    layout.pinned = m.index;
    if (m.index >= 0) {
      layout.x[m.index] = m.x;
      layout.y[m.index] = m.y;
      layout.reheat(0.25);
      kick();
    }
  }
});
