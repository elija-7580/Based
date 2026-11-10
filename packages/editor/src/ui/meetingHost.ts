// BSD-226: Was der Meeting-Block von der App braucht – Aufnahme, Wiedergabe, Zusammenfassung. Der Editor kennt nur
// diese Schnittstelle; die Web-App setzt sie aus dem MeetingRecorder (@based/brain) und einem Audio-Player zusammen.
import type { AudioTrackRole, WorkspaceStore } from "@based/core";

export interface MeetingPlayback {
  meetingID: string;
  /** Wo die Wiedergabe begonnen hat (Sekunden im Meeting). */
  from: number;
  /** Aktuelle Position (Sekunden im Meeting). */
  position: number;
  playing: boolean;
  error?: string | undefined;
}

export interface MeetingHostState {
  /** Das Meeting, das gerade aufnimmt. */
  meetingID: string | undefined;
  recording: boolean;
  paused: boolean;
  elapsed: number;
  roles: readonly AudioTrackRole[];
  processing: readonly string[];
  summarizing: readonly string[];
  error: string | undefined;
  warning: string | undefined;
  playback: MeetingPlayback | undefined;
}

export interface MeetingHost {
  /** Gleiches Objekt, solange sich nichts geändert hat (useSyncExternalStore). */
  getState(): MeetingHostState;
  subscribe(onChange: () => void): () => void;
  /** Mikrofon-Aufnahme ist hier möglich. */
  canRecord(): boolean;
  /** Tab-/Systemton lässt sich hier zusätzlich aufnehmen. */
  canCaptureSystemAudio(): boolean;
  /** Es gibt eine Transkription (sonst: Aufnahme + Notizen, Hinweis im Transkript-Tab). */
  hasTranscriber(): boolean;
  /** Eine KI für die Zusammenfassung ist eingerichtet. */
  hasSummaryEngine(): boolean;
  /** Letzter Fehler dieses Meetings (Aufnahme, Transkription). */
  errorFor(meetingID: string): string | undefined;
  start(store: WorkspaceStore, meetingID: string, opts: { systemAudio: boolean }): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  summarize(store: WorkspaceStore, meetingID: string): Promise<void>;
  /** Ab `seconds` (im Meeting) abspielen. */
  play(store: WorkspaceStore, meetingID: string, seconds: number): void;
  stopPlayback(): void;
}
