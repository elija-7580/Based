// BSD-317: Hauptthread-Seite des Hybrid-Notion-Imports. Der Import läuft länger als der Dialog, der ihn startet:
// deshalb hält ihn ein kleiner Verwalter (`hybridImport`), den Dialog, Seitenleiste und Seitenansicht abonnieren.
// Er startet den Worker, beantwortet dessen HTTP-Anfragen über den Transport der Hülle, reicht Schreibschritte und
// Dateien an den Store-Worker und legt den Stand lokal ab (damit ein Neustart dort weitermacht).
import type {
  HybridErrorKind, HybridImportReport, HybridImportState, HybridMode, HybridPageContent, HybridProgress, HybridStructureWire, NotionTransport,
} from "@based/core";
import type { StreamedAsset } from "./importer.js";
import type { StoreClient } from "./client.js";

export type HybridWorkerRequest =
  | { type: "start"; token: string; mode: HybridMode; zip?: Blob; zipName?: string; baseURL?: string; downloadFiles?: boolean; requestsPerSecond?: number }
  | { type: "http"; id: number; status?: number; headers?: Record<string, string>; body?: Uint8Array; error?: string }
  | { type: "rpc"; id: number; result?: unknown; error?: string }
  | { type: "ack"; id: number }
  | { type: "prioritize"; pageID: string }
  | { type: "cancel" };

export type HybridWorkerEvent =
  | { type: "http"; id: number; method: string; url: string; headers: Record<string, string>; body?: string }
  | { type: "rpc"; id: number; method: "commitStructure" | "pending" | "commitContent" | "loadState" | "saveState"; arg?: unknown }
  | { type: "asset"; id: number; asset: StreamedAsset }
  | { type: "progress"; progress: HybridProgress }
  | { type: "done"; report: HybridImportReport; diagnostic: string }
  | { type: "error"; message: string; kind?: HybridErrorKind; diagnostic?: string };

export interface HybridWorkerLike {
  postMessage(msg: HybridWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (e: { data: HybridWorkerEvent }) => void): void;
  terminate(): void;
}

export const createHybridWorker = (): HybridWorkerLike =>
  new Worker(new URL("./notionHybrid.worker.ts", import.meta.url), { type: "module", name: "based-notion-hybrid" }) as unknown as HybridWorkerLike;

/** Wo der Stand liegt (lokal auf diesem Gerät; die Markierungen an den Seiten selbst syncen mit dem Workspace). */
export interface HybridStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const HYBRID_STATE_KEY = "based:notion-hybrid:v1";

export interface HybridStatus {
  /** `idle`: nichts läuft. `paused`: ein früherer Lauf ist nicht fertig. `stopping`: Abbruch angefordert. */
  k: "idle" | "running" | "stopping" | "paused" | "done" | "error";
  progress?: HybridProgress;
  /** Die Struktur steht – man kann arbeiten. */
  structureReady: boolean;
  /** Seiten, die noch auf Inhalt warten. */
  remaining: number;
  waitingForZip: number;
  state?: HybridImportState;
  diagnostic?: string;
  error?: string;
  errorKind?: HybridErrorKind;
}

export interface HybridStart {
  client: StoreClient;
  token: string;
  mode: HybridMode;
  zip?: Blob | undefined;
  zipName?: string | undefined;
  transport: NotionTransport;
  baseURL?: string | undefined;
  downloadFiles?: boolean | undefined;
  requestsPerSecond?: number | undefined;
  make?: (() => HybridWorkerLike) | undefined;
}

const safeStorage = (): HybridStateStorage | undefined => {
  try { return globalThis.localStorage; } catch { return undefined; }
};

export class HybridImportManager {
  private listeners = new Set<() => void>();
  private worker: HybridWorkerLike | undefined;
  private abort: AbortController | undefined;
  status: HybridStatus = { k: "idle", structureReady: false, remaining: 0, waitingForZip: 0 };

  constructor(private readonly storage: () => HybridStateStorage | undefined = safeStorage) {}

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getStatus = () => this.status;
  private set(next: HybridStatus) { this.status = next; for (const fn of [...this.listeners]) fn(); }

  savedState(): HybridImportState | undefined {
    try {
      const raw = this.storage()?.getItem(HYBRID_STATE_KEY);
      const s = raw ? (JSON.parse(raw) as HybridImportState) : undefined;
      return s && s.version === 1 ? s : undefined;
    } catch { return undefined; }
  }

  private saveState(s: HybridImportState) {
    try { this.storage()?.setItem(HYBRID_STATE_KEY, JSON.stringify(s)); } catch { /* voller Speicher: der Lauf geht weiter, nur der Bericht fehlt nach einem Neustart */ }
  }

  /** Den gemerkten Stand vergessen (die Seiten bleiben; wartende Seiten bleiben gesperrt, bis ein Lauf sie lädt). */
  forget() {
    try { this.storage()?.removeItem(HYBRID_STATE_KEY); } catch { /* nichts zu tun */ }
    if (!this.running) this.set({ k: "idle", structureReady: false, remaining: 0, waitingForZip: 0 });
  }

  get running() { return this.status.k === "running" || this.status.k === "stopping"; }

  /** Nach dem Start der App: gibt es einen unfertigen Lauf? Dann zeigt die Oberfläche „Continue“. */
  async restore(client: StoreClient): Promise<void> {
    if (this.running) return;
    const state = this.savedState();
    const pending = await client.hybridPending().catch(() => []);
    if (pending.length === 0) {
      if (state && state.phase !== "done" && state.phase !== "structure") this.saveState({ ...state, phase: "done" });
      return;
    }
    this.set({ k: "paused", structureReady: true, remaining: pending.length, waitingForZip: pending.filter((p) => p.source === "zip").length, ...(state ? { state } : {}) });
  }

  start(s: HybridStart): void {
    if (this.running) return;
    const worker = (s.make ?? createHybridWorker)();
    const abort = new AbortController();
    this.worker = worker;
    this.abort = abort;
    this.set({ k: "running", structureReady: s.mode === "resume" && this.savedState()?.phase === "content", remaining: this.status.remaining, waitingForZip: 0,
      progress: { phase: "structure", fraction: 0, message: "Connecting to Notion…", done: 0, total: 0 } });
    const end = (next: HybridStatus) => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      this.abort = undefined;
      abort.abort();
      worker.terminate();
      this.set(next);
    };
    const reply = (id: number, p: Promise<unknown>) => {
      void p.then(
        (result) => { if (this.worker === worker) worker.postMessage({ type: "rpc", id, result }); },
        (err: unknown) => { if (this.worker === worker) worker.postMessage({ type: "rpc", id, error: err instanceof Error ? err.message : String(err) }); },
      );
    };
    worker.addEventListener("message", (e) => {
      const m = e.data;
      if (this.worker !== worker) return;
      switch (m.type) {
        case "http":
          void s.transport.send(m.method, m.url, m.headers, m.body, abort.signal).then(
            (r) => {
              if (this.worker !== worker) return;
              const body = r.body.byteOffset === 0 && r.body.byteLength === r.body.buffer.byteLength ? r.body : r.body.slice();
              worker.postMessage({ type: "http", id: m.id, status: r.status, headers: r.headers, body }, [body.buffer as ArrayBuffer]);
            },
            (err: unknown) => { if (this.worker === worker) worker.postMessage({ type: "http", id: m.id, error: err instanceof Error ? err.message : String(err) }); },
          );
          break;
        case "rpc":
          switch (m.method) {
            case "commitStructure": reply(m.id, s.client.hybridStructure(m.arg as HybridStructureWire)); break;
            case "pending": reply(m.id, s.client.hybridPending()); break;
            case "commitContent": reply(m.id, s.client.hybridContent(m.arg as HybridPageContent[])); break;
            case "loadState": reply(m.id, Promise.resolve(this.savedState())); break;
            case "saveState": {
              const state = m.arg as HybridImportState;
              this.saveState(state);
              if (this.status.k === "running" || this.status.k === "stopping") this.set({ ...this.status, state, structureReady: this.status.structureReady || state.phase !== "structure" });
              reply(m.id, Promise.resolve(null));
              break;
            }
          }
          break;
        case "asset":
          // Erst bestätigen, wenn die Datei abgelegt ist (oder nicht ablegbar war) – der Schritt, der auf sie zeigt, wartet darauf.
          void s.client.importAsset(m.asset).then(() => true, () => false).then(() => { if (this.worker === worker) worker.postMessage({ type: "ack", id: m.id }); });
          break;
        case "progress":
          if (this.status.k === "running" || this.status.k === "stopping") {
            this.set({ ...this.status, progress: m.progress, structureReady: this.status.structureReady || m.progress.phase === "content", ...(m.progress.phase === "content" ? { remaining: Math.max(0, m.progress.total - m.progress.done) } : {}) });
          }
          break;
        case "done": {
          const r = m.report;
          const left = r.remaining > 0;
          end({ k: left ? "paused" : "done", structureReady: true, remaining: r.remaining, waitingForZip: r.waitingForZip, state: r.state, diagnostic: m.diagnostic });
          // Wie viele der wartenden Seiten das ZIP brauchen, weiß nur der Store.
          if (left) void s.client.hybridPending().then((p) => { if (this.status.k === "paused") this.set({ ...this.status, remaining: p.length, waitingForZip: p.filter((x) => x.source === "zip").length }); }, () => undefined);
          break;
        }
        case "error": {
          const state = this.savedState();
          end({ k: "error", structureReady: state !== undefined && state.phase !== "structure", remaining: this.status.remaining, waitingForZip: 0, error: m.message,
            ...(m.kind ? { errorKind: m.kind } : {}), ...(m.diagnostic ? { diagnostic: m.diagnostic } : {}), ...(state ? { state } : {}) });
          break;
        }
      }
    });
    worker.postMessage({ type: "start", token: s.token, mode: s.mode, ...(s.zip ? { zip: s.zip } : {}), ...(s.zipName ? { zipName: s.zipName } : {}), ...(s.baseURL ? { baseURL: s.baseURL } : {}),
      ...(s.downloadFiles !== undefined ? { downloadFiles: s.downloadFiles } : {}), ...(s.requestsPerSecond !== undefined ? { requestsPerSecond: s.requestsPerSecond } : {}) });
  }

  /** Anhalten: der laufende Schritt wird noch geschrieben, der Rest bleibt vorgemerkt („Continue“). */
  cancel() {
    if (this.status.k !== "running" || !this.worker) return;
    this.set({ ...this.status, k: "stopping" });
    this.worker.postMessage({ type: "cancel" });
    this.abort?.abort();
  }

  /** Eine geöffnete Seite vorziehen. */
  prioritize(pageID: string) {
    if (this.running) this.worker?.postMessage({ type: "prioritize", pageID });
  }

  /** Den Abschluss- oder Fehlerhinweis wegklicken. */
  dismiss() {
    if (this.status.k === "done" || this.status.k === "error") this.set({ k: "idle", structureReady: false, remaining: 0, waitingForZip: 0 });
  }
}

export const hybridImport = new HybridImportManager();
