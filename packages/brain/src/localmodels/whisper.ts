// BSD-231 Teil 3c: Transkription mit whisper.cpp hinter `Transcriber` (Meeting Notes, BSD-226). Die Aufnahme (webm/opus
// aus MediaRecorder) dekodiert die Web-App selbst (AudioContext), hier wird sie auf 16 kHz mono gebracht, als WAV
// verpackt und an den eigenen based-server geschickt (POST /local/transcribe, dort whisper.cpp mit dem Modell aus dem
// Katalog). Kein fremder Server: `post` wird hineingereicht. Das Ergebnis (whisper-cli `-oj`) wird zu Segmenten mit
// Zeiten im Meeting (Spur-Beginn addiert) und der Spur-Rolle.
import type { TranscriptSegment } from "@based/core";
import type { TrackAudio, Transcriber, TranscriberContext } from "../meeting.js";

export const WHISPER_RATE = 16_000;

/** Kanäle mitteln und auf 16 kHz bringen (Mittelwert über das Quellfenster je Zielwert; genügt für Sprache). */
export function toMono16k(channels: readonly Float32Array[], sampleRate: number): Float32Array {
  const n = Math.min(...channels.map((c) => c.length));
  if (!channels.length || !Number.isFinite(n) || n === 0 || !(sampleRate > 0)) return new Float32Array(0);
  const mono = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) mono[i] = mono[i]! + c[i]! / channels.length;
  if (sampleRate === WHISPER_RATE) return mono;
  const ratio = sampleRate / WHISPER_RATE;
  const out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const from = i * ratio, to = Math.min(n, (i + 1) * ratio);
    if (ratio >= 1) {
      // Abwärts: Mittelwert über das Fenster (einfacher Tiefpass gegen Aliasing).
      let sum = 0, count = 0;
      for (let j = Math.floor(from); j < Math.ceil(to); j++) { sum += mono[j]!; count++; }
      out[i] = count ? sum / count : 0;
    } else {
      // Aufwärts: linear zwischen den Nachbarn.
      const j = Math.floor(from), f = from - j;
      out[i] = mono[j]! * (1 - f) + (mono[Math.min(j + 1, n - 1)]! * f);
    }
  }
  return out;
}

/** PCM (−1 … 1) als WAV, 16 Bit, mono. */
export function encodeWav(pcm: Float32Array, sampleRate = WHISPER_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i); };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i]!));
    v.setInt16(44 + i * 2, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true);
  }
  return bytes;
}

/** Ausgabe von `whisper-cli -oj` (nur, was gebraucht wird). */
export interface WhisperJSON {
  result?: { language?: string };
  transcription?: { offsets?: { from?: number; to?: number }; text?: string }[];
}

/** whisper-cli-JSON → Zeilen (Sekunden ab Dateibeginn); leere Zeilen und „[BLANK_AUDIO]“ fallen weg. */
export function parseWhisperJSON(json: WhisperJSON): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (const t of json.transcription ?? []) {
    const text = (t.text ?? "").trim();
    if (!text || /^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]$/i.test(text) || /^\((?:music|silence)\)$/i.test(text)) continue;
    const start = (t.offsets?.from ?? 0) / 1000, end = (t.offsets?.to ?? t.offsets?.from ?? 0) / 1000;
    out.push({ start, end: Math.max(start, end), text });
  }
  return out;
}

/** Höchstens so lange Stücke an den Server (5 min ≈ 9,6 MB WAV; Grenze dort 16 MiB). */
export const CHUNK_SECONDS = 300;

/**
 * Lange Aufnahmen in Stücke von höchstens `max` Sekunden teilen, geschnitten an der leisesten Stelle (100-ms-Fenster)
 * in den letzten 10 Sekunden vor der Grenze – nicht mitten im Wort. Gibt [von, bis) in Samples zurück.
 */
export function splitAtQuiet(pcm: Float32Array, max = CHUNK_SECONDS, rate = WHISPER_RATE): [number, number][] {
  const limit = Math.floor(max * rate);
  const out: [number, number][] = [];
  const win = Math.floor(rate / 10);
  let start = 0;
  while (pcm.length - start > limit) {
    const end = start + limit;
    let best = end, quiet = Infinity;
    for (let w = Math.max(start + win, end - 10 * rate); w + win <= end; w += win) {
      let e = 0;
      for (let i = w; i < w + win; i++) e += pcm[i]! * pcm[i]!;
      if (e < quiet) { quiet = e; best = w + Math.floor(win / 2); }
    }
    out.push([start, best]);
    start = best;
  }
  if (pcm.length > start) out.push([start, pcm.length]);
  return out;
}

export interface WhisperTranscriberOptions {
  /** Spur-Daten (z. B. Blob) → PCM-Kanäle (Web: AudioContext.decodeAudioData). */
  decode(data: unknown): Promise<{ channels: Float32Array[]; sampleRate: number }>;
  /** WAV an den eigenen Server (POST /local/transcribe) → whisper-cli-JSON. */
  post(wav: Uint8Array, opts: { language?: string | undefined; prompt?: string | undefined }): Promise<WhisperJSON>;
  id?: string;
}

/** Finale Transkription jeder Spur mit whisper.cpp auf dem eigenen Server (kein Live-Transkript). */
export class WhisperServerTranscriber implements Transcriber {
  readonly id: string;
  constructor(private readonly o: WhisperTranscriberOptions) {
    this.id = o.id ?? "whisper.cpp";
  }

  async final(tracks: readonly TrackAudio[], ctx: TranscriberContext): Promise<{ segments: TranscriptSegment[] }> {
    const segments: TranscriptSegment[] = [];
    // Fachwörter als Startkontext (whisper --prompt), knapp halten.
    const prompt = ctx.vocabulary.length ? ctx.vocabulary.join(", ").slice(0, 400) : undefined;
    for (const t of tracks) {
      if (t.data === undefined) continue;
      const { channels, sampleRate } = await this.o.decode(t.data);
      const pcm = toMono16k(channels, sampleRate);
      if (pcm.length < WHISPER_RATE / 10) continue; // < 0,1 s
      let n = 0;
      for (const [from, to] of splitAtQuiet(pcm)) {
        const json = await this.o.post(encodeWav(pcm.subarray(from, to)), { language: ctx.language, prompt });
        const at = t.offset + from / WHISPER_RATE;
        for (const l of parseWhisperJSON(json)) {
          // Sprecher setzt der MeetingRecorder (Mikrofon = „me“ nur, wenn es eine Systemspur gibt).
          segments.push({ id: `w${t.index}-${n++}`, s: at + l.start, e: at + l.end, t: l.text, tr: t.role });
        }
      }
    }
    segments.sort((a, b) => a.s - b.s || a.id.localeCompare(b.id));
    return { segments };
  }
}
