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
