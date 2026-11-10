// BSD-226: Aufnahme im Browser/Tauri – Mikrofon über getUserMedia + MediaRecorder, optional Tab-/Systemton über
// getDisplayMedia (nur Chromium liefert dort Ton). Mikrofon und geteilter Ton sind getrennte Spuren (Me / Others).
// Live-Stücke gehen jede Sekunde an den Transcriber; nach dem Stop gibt es je Spur eine Datei.
import type { AudioCapture, AudioChunk, CaptureOptions, CapturedTrack } from "@based/brain";
import type { AudioTrackRole } from "@based/core";

const media = (): MediaDevices | undefined => (typeof navigator === "undefined" ? undefined : navigator.mediaDevices);

export function canRecordAudio(): boolean {
  return typeof MediaRecorder !== "undefined" && typeof media()?.getUserMedia === "function";
}

/** Tab-/Systemton gibt es nur in Chromium über getDisplayMedia (Firefox und Safari liefern dort keinen Ton). */
export function canCaptureSystemAudio(): boolean {
  if (!canRecordAudio() || typeof media()?.getDisplayMedia !== "function") return false;
  const ua = navigator.userAgent;
  return /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox\//.test(ua);
}

function pickMime(): string | undefined {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

const extFor = (mime: string) => (mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm");

/** Uhr ohne Pausen. */
class Clock {
  private startedAt = performance.now();
  private pausedAt: number | undefined;
  private pausedTotal = 0;
  pause() {
    this.pausedAt ??= performance.now();
  }
  resume() {
    if (this.pausedAt !== undefined) this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = undefined;
  }
  seconds(): number {
    const now = this.pausedAt ?? performance.now();
    return Math.max(0, (now - this.startedAt - this.pausedTotal) / 1000);
  }
}

interface Track {
  role: AudioTrackRole;
  recorder: MediaRecorder;
  parts: Blob[];
  lastEnd: number;
}

class BrowserCapture implements AudioCapture {
  readonly roles: AudioTrackRole[];
  private readonly clock = new Clock();
  private stopped = false;

  constructor(private readonly tracks: Track[], private readonly streams: MediaStream[], readonly warning: string | undefined, onChunk: (c: AudioChunk) => void) {
    this.roles = tracks.map((t) => t.role);
    for (const t of tracks) {
      t.recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        t.parts.push(e.data);
        const end = this.clock.seconds();
        onChunk({ role: t.role, start: t.lastEnd, end, data: e.data, mime: t.recorder.mimeType });
        t.lastEnd = end;
      };
      t.recorder.start(1000);
    }
  }

  pause() {
    this.clock.pause();
    for (const t of this.tracks) if (t.recorder.state === "recording") t.recorder.pause();
  }

  resume() {
    this.clock.resume();
    for (const t of this.tracks) if (t.recorder.state === "paused") t.recorder.resume();
  }

  elapsed() {
    return this.clock.seconds();
  }

  async stop(): Promise<CapturedTrack[]> {
    if (this.stopped) return [];
    this.stopped = true;
    const duration = this.clock.seconds();
    const done = this.tracks.map((t) => new Promise<void>((resolve) => {
      if (t.recorder.state === "inactive") return resolve();
      t.recorder.addEventListener("stop", () => resolve(), { once: true });
      t.recorder.stop();
    }));
    await Promise.all(done);
    for (const s of this.streams) for (const tr of s.getTracks()) tr.stop();
    return this.tracks.map((t) => {
      const mime = (t.recorder.mimeType || "audio/webm").split(";")[0]!;
      return { role: t.role, data: new Blob(t.parts, { type: mime }), mime, duration: Math.round(duration * 100) / 100, name: `${t.role === "system" ? "system" : "microphone"}.${extFor(mime)}` };
    });
  }
}

/** Startet die Aufnahme (fragt nach dem Mikrofon und ggf. nach dem geteilten Tab/Bildschirm). */
export async function startBrowserCapture(opts: CaptureOptions): Promise<AudioCapture> {
  const devices = media();
  if (!devices || !canRecordAudio()) throw new Error("Recording isn't available in this browser.");
  const mic = await devices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const streams = [mic];
  const mime = pickMime();
  const recorder = (s: MediaStream) => new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
  const tracks: Track[] = [{ role: "microphone", recorder: recorder(mic), parts: [], lastEnd: 0 }];
  let warning: string | undefined;
  if (opts.systemAudio) {
    try {
      const shared = await devices.getDisplayMedia({ video: true, audio: true });
      streams.push(shared);
      const audio = shared.getAudioTracks();
      if (audio.length === 0) {
        for (const tr of shared.getTracks()) tr.stop();
        warning = "No audio was shared, so only your microphone is recorded. Tick “Share audio” when choosing the tab.";
      } else {
        tracks.push({ role: "system", recorder: recorder(new MediaStream(audio)), parts: [], lastEnd: 0 });
      }
    } catch {
      warning = "Sharing was cancelled, so only your microphone is recorded.";
    }
  }
  return new BrowserCapture(tracks, streams, warning, opts.onChunk);
}
