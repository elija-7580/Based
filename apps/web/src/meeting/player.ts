// BSD-226: Wiedergabe einer Meeting-Aufnahme ab einer Stelle. Spielt alle Spuren der Aufnahme, in die die Stelle
// fällt, gleichzeitig (Mikrofon + geteilter Ton); die Bytes kommen aus dem Asset-Speicher (lokal oder Sync-Server).
import type { MeetingTrack } from "@based/core";
import type { MeetingPlayback } from "@based/editor";

export interface AudioSource {
  /** Blob-URL einer Spur (wirft, wenn die Datei nicht geladen werden kann). */
  url(assetID: string): Promise<string>;
}

/** Die Spuren, die zur Stelle `seconds` gehören: die Aufnahme, in die sie fällt, sonst die nächste davor. */
export function tracksAt(tracks: readonly MeetingTrack[], seconds: number): MeetingTrack[] {
  if (tracks.length === 0) return [];
  const inside = tracks.filter((t) => seconds >= t.offset && (t.duration === undefined || seconds < t.offset + t.duration + 0.5));
  if (inside.length) return inside;
  const before = tracks.filter((t) => t.offset <= seconds);
  const offset = before.length ? Math.max(...before.map((t) => t.offset)) : Math.min(...tracks.map((t) => t.offset));
  return tracks.filter((t) => t.offset === offset);
}

export class MeetingPlayer {
  private audios: { el: HTMLAudioElement; offset: number }[] = [];
  private state: MeetingPlayback | undefined;
  private token = 0;

  constructor(private readonly source: AudioSource, private readonly onChange: () => void) {}

  get playback(): MeetingPlayback | undefined {
    return this.state;
  }

  private set(p: MeetingPlayback | undefined) {
    this.state = p;
    this.onChange();
  }

  async play(meetingID: string, tracks: readonly MeetingTrack[], seconds: number): Promise<void> {
    this.stop(false);
    const token = ++this.token;
    const chosen = tracksAt(tracks, seconds);
    this.set({ meetingID, from: seconds, position: seconds, playing: false });
    if (chosen.length === 0) {
      this.set({ meetingID, from: seconds, position: seconds, playing: false, error: "No recording yet." });
      return;
    }
    try {
      const urls = await Promise.all(chosen.map((t) => this.source.url(t.asset.id)));
      if (token !== this.token) return;
      this.audios = chosen.map((t, i) => {
        const el = new Audio(urls[i]);
        el.preload = "auto";
        return { el, offset: t.offset };
      });
      const lead = this.audios[0]!;
      lead.el.addEventListener("timeupdate", () => {
        if (token === this.token && this.state) this.set({ ...this.state, position: lead.offset + lead.el.currentTime });
      });
      lead.el.addEventListener("ended", () => {
        if (token === this.token && this.state) this.set({ ...this.state, playing: false });
      });
      await Promise.all(this.audios.map(async ({ el, offset }) => {
        el.currentTime = Math.max(0, seconds - offset);
        await el.play();
      }));
      if (token === this.token) this.set({ meetingID, from: seconds, position: seconds, playing: true });
    } catch (e) {
      if (token !== this.token) return;
      this.set({ meetingID, from: seconds, position: seconds, playing: false, error: "Can't play the recording: " + (e instanceof Error ? e.message : String(e)) });
    }
  }

  stop(notify = true) {
    this.token++;
    for (const a of this.audios) {
      a.el.pause();
      a.el.removeAttribute("src");
    }
    this.audios = [];
    if (notify) this.set(undefined);
  }
}
