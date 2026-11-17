// BSD-231 Teil 3c: Transkription über den eigenen based-server (whisper.cpp, POST /local/transcribe). Nur wenn der
// verbundene Server sie anbietet (GET /local/transcribe → ready); kein fremder Dienst. Der Browser dekodiert die
// Aufnahme (webm/opus) und rechnet sie dabei schon auf 16 kHz um (OfflineAudioContext); den Rest macht @based/brain.
import { localModels } from "@based/brain";

export interface ServerAccess { url: string; token: string }

const base = (cfg: ServerAccess) => cfg.url.replace(/\/+$/, "");

/** Bietet der Server Transkription an? (Fehler, 404, Gast → nein.) */
export async function whisperReady(cfg: ServerAccess | undefined, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<boolean> {
  if (!cfg?.url) return false;
  try {
    const r = await fetcher(`${base(cfg)}/local/transcribe`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    return r.ok && ((await r.json()) as { ready?: boolean }).ready === true;
  } catch {
    return false;
  }
}

/** Blob → PCM in 16 kHz (der Browser resampelt beim Dekodieren). */
async function decodeInBrowser(data: unknown): Promise<{ channels: Float32Array[]; sampleRate: number }> {
  const bytes = data instanceof Blob ? await data.arrayBuffer() : (data as ArrayBuffer);
  const ctx = new OfflineAudioContext(1, 1, localModels.WHISPER_RATE);
  const audio = await ctx.decodeAudioData(bytes);
  return { channels: Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i)), sampleRate: audio.sampleRate };
}

export function serverWhisper(cfg: ServerAccess, opts: { fetcher?: typeof fetch; decode?: localModels.WhisperTranscriberOptions["decode"] } = {}) {
  const fetcher = opts.fetcher ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return new localModels.WhisperServerTranscriber({
    id: "whisper.cpp (server)",
    decode: opts.decode ?? decodeInBrowser,
    async post(wav, o) {
      const q = new URLSearchParams();
      if (o.language) q.set("language", o.language);
      if (o.prompt) q.set("prompt", o.prompt);
      const r = await fetcher(`${base(cfg)}/local/transcribe${q.size ? `?${q}` : ""}`, {
        method: "POST", body: wav as BodyInit, headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "audio/wav" },
      });
      const body = (await r.json().catch(() => ({}))) as localModels.WhisperJSON & { error?: string };
      if (!r.ok) throw new Error(`Transcription failed: ${body.error ?? `HTTP ${r.status}`}`);
      return body;
    },
  });
}

// Feedback 17. 11.: Einrichten in der App (Einstellungen → Meeting notes) – was fehlt, Modell laden/abbrechen/entfernen.

export interface TranscribeModelState {
  source: "file" | "catalog" | "none";
  installed: boolean;
  downloading?: boolean;
  /** Bytes bisher / insgesamt (nur Katalog). */
  loaded?: number;
  size?: number;
  name?: string;
  error?: string;
}
export interface TranscribeStatus { engineInstalled: boolean; ready: boolean; model: TranscribeModelState }

/** Stand der Transkription auf einem Server; `undefined`: er bietet sie nicht an (keine Route, Gast, nicht erreichbar). */
export async function transcribeStatus(cfg: ServerAccess | undefined, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<TranscribeStatus | undefined> {
  if (!cfg?.url) return undefined;
  try {
    const r = await fetcher(`${base(cfg)}/local/transcribe`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!r.ok) return undefined;
    const b = (await r.json()) as { ready?: boolean; engineInstalled?: boolean; model?: Partial<TranscribeModelState> };
    const model: TranscribeModelState = { source: "none", installed: false, ...b.model };
    // Ältere Server melden engineInstalled nicht: dort gibt es die Route nur mit eingerichtetem Programm.
    return { engineInstalled: b.engineInstalled ?? true, ready: b.ready === true, model };
  } catch {
    return undefined;
  }
}

/** Modell aus dem Katalog laden, abbrechen oder entfernen – nur auf ausdrücklichen Klick. */
export async function transcribeModel(cfg: ServerAccess, action: "download" | "cancel" | "remove", fetcher: typeof fetch = (...a) => fetch(...a)): Promise<void> {
  const r = await fetcher(`${base(cfg)}/local/transcribe/model`, { method: "POST", body: JSON.stringify({ action }), headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" } });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
}

export type TranscriptionStep = "no-server" | "no-engine" | "no-model" | "downloading" | "ready";

/** Reine Regel (getestet): der nächste fehlende Schritt. */
export function transcriptionStep(status: TranscribeStatus | undefined): TranscriptionStep {
  if (!status) return "no-server";
  if (status.ready) return "ready";
  if (status.model.downloading) return "downloading";
  if (!status.engineInstalled) return "no-engine";
  return "no-model";
}

/** Fortschritt in Prozent (0–100), `undefined` ohne Größe. */
export function downloadPercent(model: TranscribeModelState): number | undefined {
  if (!model.size || model.loaded === undefined) return undefined;
  return Math.max(0, Math.min(100, Math.floor((model.loaded / model.size) * 100)));
}

/** „148 MB“ */
export const megabytes = (bytes: number | undefined) => (bytes ? `${Math.round(bytes / 1_000_000)} MB` : "");

// Die Einstellungen melden „es hat sich etwas geändert“ – der Aufnahmedienst (host.ts) fragt dann neu nach.
const changed = new Set<() => void>();
export function onTranscriptionChanged(fn: () => void): () => void {
  changed.add(fn);
  return () => void changed.delete(fn);
}
export function transcriptionChanged() {
  for (const fn of [...changed]) fn();
}
