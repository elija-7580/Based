// BSD-226: Meeting-Notizen – Aufnahmedienst ohne DOM (Swift legacy/App/Shared/Meeting/MeetingService.swift): Aufnahme →
// Live-Transkript → (Stop) finaler Durchlauf → Zusammenfassung über die konfigurierte Engine.
//
// Aufnahme, Transkription und Ablage kommen als Schnittstellen herein: im Browser MediaRecorder + Asset-Speicher,
// in Tests Fakes. Ohne Transcriber funktionieren Aufnahme und Notizen mit Zeitstempel trotzdem.
import {
  addMeetingTrack, appendTranscript, applyMeetingSummary, findMeetingSection, meetingContextText, meetingInfo, meetingNotesText,
  meetingTranscript, meetingVocabulary, mergedSpeakers, ME_SPEAKER, OTHERS_SPEAKER, parseKey, plainText, replaceTranscript,
  setMeetingStatus, stampNote, transcriptText, unstampedNotes, updateMeeting,
  type AudioTrackRole, type MeetingTrack, type SpeakerTurn, type StoreChange, type TranscriptSegment, type WorkspaceStore,
} from "@based/core";
import { runTurn, type ChatEngine } from "./engine.js";

// MARK: Zusammenfassung (Prompt wie Swift MeetingSummaryPrompt)

export const MEETING_SUMMARY_SYSTEM = "You write meeting notes from a transcript. Be accurate and concise; never invent facts, names or numbers "
  + "that are not in the transcript or the context. Answer in the language most of the meeting was held in.";

export function meetingSummaryPrompt(o: { title: string; transcript: string; notes: string; context: string; instructions?: string | undefined }): string {
  let p = `Meeting: ${o.title}\n\n`;
  if (o.context !== "") p += `<context>\n${o.context}\n</context>\n\n`;
  if (o.notes !== "") p += `<my_notes>\n${o.notes}\n</my_notes>\n\n`;
  p += `<transcript>\n${o.transcript}\n</transcript>\n\n`;
  p += [
    "Write the summary as Markdown with exactly these sections (translated into the meeting's language):",
    "## Summary — 2–5 sentences.",
    "## Key points — bullets.",
    "## Decisions — bullets (omit the section if there were none).",
    "## Action items — to-dos as `- [ ] Owner: task (due date if mentioned)`.",
    "After each bullet, cite where it was said with the transcript timecode in square brackets, e.g. [12:34].",
    "Treat my notes as the most important signal of what mattered. Do not include the transcript itself.",
  ].join("\n");
  const extra = o.instructions?.trim();
  if (extra) p += `\n\nAdditional instructions: ${extra}`;
  return p;
}

/** Modelle packen die Antwort manchmal in ```markdown-Zäune. */
export function stripFence(s: string): string {
  let t = s.trim();
  if (t.startsWith("```")) {
    const nl = t.indexOf("\n");
    t = nl >= 0 ? t.slice(nl + 1) : "";
    if (t.trimEnd().endsWith("```")) t = t.trimEnd().slice(0, -3);
  }
  return t.trim();
}

/** Ein Turn ohne Werkzeuge; liefert den Antworttext (wirft bei Fehler/Abbruch). */
export async function completeText(engine: ChatEngine, prompt: string, system: string, signal: AbortSignal): Promise<string> {
  let text = "";
  for await (const e of runTurn(engine, { prompt, system }, signal)) {
    if (e.type === "text") text = text ? text + "\n\n" + e.text : e.text;
    if (e.type === "failed") throw new Error(e.message);
    if (e.type === "result") {
      if (e.isError) throw new Error(e.text || "The model returned an error.");
      return e.text || text;
    }
  }
  return text;
}

/** Transkript für den Prompt; sehr lange: Anfang und Ende (die zählen am meisten). */
export function clipTranscript(text: string, max = 120_000): string {
  return text.length > max ? text.slice(0, max / 2) + "\n[…]\n" + text.slice(-max / 2) : text;
}

/** Prompt für ein Meeting aus dem Store (Transkript ohne vorläufige Segmente, Notizen mit Zeit, Kontext, Vokabular). */
export function buildMeetingSummaryPrompt(store: WorkspaceStore, meetingID: string): string | undefined {
  const b = store.blocks.get(meetingID);
  const info = meetingInfo(store, meetingID);
  if (!b || !info) return undefined;
  const transcript = transcriptText(meetingTranscript(store, meetingID, false), info);
  const notes = meetingNotesText(store, meetingID);
  if (transcript === "" && notes === "") return undefined;
  let context = meetingContextText(store, meetingID, 24_000);
  const vocabulary = meetingVocabulary(store, meetingID, 60);
  if (vocabulary.length) context += (context ? "\n\n" : "") + "Correct spellings of names and terms (the transcript may have misheard them): " + vocabulary.join(", ");
  return meetingSummaryPrompt({ title: plainText(b.text) || "Meeting notes", transcript: clipTranscript(transcript), notes, context, instructions: info.summaryInstructions });
}

// MARK: Aufnahme und Transkription (Schnittstellen)

/** Ein Stück Audio während der Aufnahme (Zeiten in Sekunden ab Beginn dieser Aufnahme, Pausen ausgenommen). */
export interface AudioChunk {
  role: AudioTrackRole;
  start: number;
  end: number;
  /** Die Bytes (Blob im Browser); der Transcriber weiß, was er damit anfängt. */
  data: unknown;
  mime?: string | undefined;
}

/** Eine fertige Spur nach dem Stop. */
export interface CapturedTrack {
  role: AudioTrackRole;
  data: unknown;
  mime: string;
  /** Sekunden (Pausen ausgenommen). */
  duration: number;
  name: string;
}

export interface AudioCapture {
  /** Spuren, die wirklich aufgenommen werden (z. B. nur Mikrofon, wenn kein Systemton freigegeben wurde). */
  readonly roles: readonly AudioTrackRole[];
  /** Nicht tödlicher Hinweis (z. B. „kein Ton geteilt – nur Mikrofon“). */
  readonly warning?: string | undefined;
  pause(): void;
  resume(): void;
  /** Aufgenommene Sekunden (Pausen ausgenommen). */
  elapsed(): number;
  /** Beendet die Aufnahme; liefert die Spuren. */
  stop(): Promise<CapturedTrack[]>;
}

export interface CaptureOptions {
  /** Zusätzlich Systemton/Tab-Ton aufnehmen (wo möglich). */
  systemAudio: boolean;
  /** Live-Stücke für die Transkription. */
  onChunk: (chunk: AudioChunk) => void;
}

export type CaptureFactory = (opts: CaptureOptions) => Promise<AudioCapture>;

/** Eine Spur für den finalen Durchlauf. */
export interface TrackAudio {
  role: AudioTrackRole;
  /** Beginn im Meeting (Sekunden). */
  offset: number;
  duration?: number | undefined;
  /** Bytes der Spur (aus dem Asset-Speicher). */
  data: unknown;
  index: number;
}

export interface TranscriberContext {
  language?: string | undefined;
  vocabulary: readonly string[];
}

/**
 * Sprache → Text. `live` bekommt Stücke während der Aufnahme (Segment-IDs stabil halten: gleiche ID ersetzt), `final`
 * transkribiert danach jede ganze Spur und darf Sprecherabschnitte (`turns`) liefern.
 */
export interface Transcriber {
  /** Kennung für `MeetingInfo.engine`. */
  readonly id: string;
  live?(chunk: AudioChunk & { offset: number }, ctx: TranscriberContext): Promise<TranscriptSegment[]>;
  final(tracks: readonly TrackAudio[], ctx: TranscriberContext): Promise<{ segments: TranscriptSegment[]; turns?: SpeakerTurn[] }>;
}

export interface FixedLine {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

/**
 * Transcriber mit festem Transkript (Vitest/E2E): live erscheinen die Zeilen, deren Beginn schon aufgenommen ist; der
 * finale Durchlauf liefert alle Zeilen (verschoben um den Beginn der ersten Spur).
 */
export class FixedTranscriber implements Transcriber {
  readonly id: string;
  private emitted = new Set<number>();
  constructor(private readonly lines: readonly FixedLine[], id = "test.fixed") {
    this.id = id;
  }

  live(chunk: AudioChunk & { offset: number }): Promise<TranscriptSegment[]> {
    const out: TranscriptSegment[] = [];
    this.lines.forEach((l, i) => {
      if (this.emitted.has(i) || l.start >= chunk.end) return;
      this.emitted.add(i);
      out.push(this.segment(l, i, chunk.offset, "live-", chunk.role));
    });
    return Promise.resolve(out);
  }

  final(tracks: readonly TrackAudio[]): Promise<{ segments: TranscriptSegment[] }> {
    const first = tracks[0];
    const offset = first ? Math.min(...tracks.map((t) => t.offset)) : 0;
    return Promise.resolve({ segments: this.lines.map((l, i) => this.segment(l, i, offset, "t-", first?.role)) });
  }

  private segment(l: FixedLine, i: number, offset: number, prefix: string, role: AudioTrackRole | undefined): TranscriptSegment {
    const s: TranscriptSegment = { id: prefix + i, s: l.start + offset, e: l.end + offset, t: l.text };
    if (l.speaker !== undefined) s.sp = l.speaker;
    if (role !== undefined) s.tr = role;
    return s;
  }
}

// MARK: Dienst

export interface MeetingRecorderState {
  /** Das Meeting, das gerade aufnimmt. */
  meetingID: string | undefined;
  recording: boolean;
  paused: boolean;
  /** Position im Meeting (Sekunden, inkl. früherer Aufnahmen). */
  elapsed: number;
  /** Spuren der laufenden Aufnahme. */
  roles: readonly AudioTrackRole[];
  processing: readonly string[];
  summarizing: readonly string[];
  error: string | undefined;
  warning: string | undefined;
}

/** AssetRef der gespeicherten Spur. */
export type SavedAudio = MeetingTrack["asset"];

export interface MeetingRecorderOptions {
  capture: CaptureFactory;
  /** Spur in den Asset-Speicher; liefert die AssetRef. */
  saveAudio: (track: CapturedTrack) => Promise<SavedAudio>;
  /** Bytes einer gespeicherten Spur (finaler Durchlauf). */
  loadAudio?: (asset: SavedAudio) => Promise<unknown>;
  transcriber?: () => Transcriber | undefined;
  /** Engine für die Zusammenfassung; `undefined` = keine KI eingerichtet. */
  engine?: () => Promise<ChatEngine | undefined> | ChatEngine | undefined;
  /** Takt für die Uhr (ms; Standard 250). 0 = kein Takt (Tests). */
  tickMs?: number;
}

const IDLE: MeetingRecorderState = { meetingID: undefined, recording: false, paused: false, elapsed: 0, roles: [], processing: [], summarizing: [], error: undefined, warning: undefined };

interface Session {
  store: WorkspaceStore;
  meetingID: string;
  base: number;
  capture: AudioCapture;
  unobserve: () => void;
  /** Notizen, die beim Start schon Text hatten (bekommen keinen Stempel). */
  skip: Set<string>;
  live: Promise<void>;
  timer: ReturnType<typeof setInterval> | undefined;
}

/** Eine Aufnahme gleichzeitig je Gerät; der Dienst schreibt in den Store, den `start` bekommt. */
export class MeetingRecorder {
  private state: MeetingRecorderState = IDLE;
  private listeners = new Set<() => void>();
  private session: Session | undefined;
  /** Fehler je Meeting (Anzeige im Block). */
  private errors = new Map<string, string>();

  constructor(private readonly o: MeetingRecorderOptions) {}

  getState = (): MeetingRecorderState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private set(patch: Partial<MeetingRecorderState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  hasTranscriber(): boolean {
    return this.o.transcriber?.() !== undefined;
  }

  errorFor(meetingID: string): string | undefined {
    return this.errors.get(meetingID);
  }

  /** Aktuelle Position der laufenden Aufnahme im Meeting. */
  elapsed(): number {
    const s = this.session;
    return s ? s.base + s.capture.elapsed() : this.state.elapsed;
  }

  async start(store: WorkspaceStore, meetingID: string, opts: { systemAudio?: boolean } = {}): Promise<void> {
    if (this.session || this.state.recording) return;
    const info = meetingInfo(store, meetingID);
    if (!info) return;
    this.errors.delete(meetingID);
    this.set({ error: undefined, warning: undefined });
    const base = info.duration ?? 0;
    const pending: AudioChunk[] = [];
    const box: { session?: Session } = {};
    const onChunk = (c: AudioChunk) => {
      if (!box.session) pending.push(c);
      else this.transcribeLive(box.session, c);
    };
    let capture: AudioCapture;
    try {
      capture = await this.o.capture({ systemAudio: opts.systemAudio === true, onChunk });
    } catch (e) {
      this.fail(store, meetingID, captureMessage(e));
      return;
    }
    // Notizen, die beim Start schon Text haben, bekommen keinen Stempel.
    const notes = findMeetingSection(store, meetingID, "notes");
    const skip = new Set((notes ? store.descendants(notes) : []).filter((id) => plainText(store.blocks.get(id)?.text).trim() !== ""));
    const s: Session = { store, meetingID, base, capture, skip, unobserve: () => undefined, live: Promise.resolve(), timer: undefined };
    box.session = s;
    this.session = s;
    s.unobserve = store.observe((c) => this.onStoreChange(s, c));
    const roles = capture.roles;
    updateMeeting(store, meetingID, (m) => {
      if ((!m.speakers || m.speakers.length === 0) && roles.includes("system")) {
        m.speakers = [{ id: ME_SPEAKER, name: "Me", isMe: true, color: "default" }, { id: OTHERS_SPEAKER, name: "Others", color: "blue" }];
      }
    }, { name: "Start recording", undoable: false });
    setMeetingStatus(store, meetingID, "recording");
    const tick = this.o.tickMs ?? 250;
    if (tick > 0) s.timer = setInterval(() => this.set({ elapsed: this.elapsed() }), tick);
    this.set({ meetingID, recording: true, paused: false, elapsed: base, roles, warning: capture.warning });
    for (const c of pending) this.transcribeLive(s, c);
  }

  pause() {
    const s = this.session;
    if (!s || this.state.paused) return;
    s.capture.pause();
    setMeetingStatus(s.store, s.meetingID, "paused");
    this.set({ paused: true, elapsed: this.elapsed() });
  }

  resume() {
    const s = this.session;
    if (!s || !this.state.paused) return;
    s.capture.resume();
    setMeetingStatus(s.store, s.meetingID, "recording");
    this.set({ paused: false });
  }

  async stop(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    if (s.timer !== undefined) clearInterval(s.timer);
    s.unobserve();
    const elapsed = s.base + s.capture.elapsed();
    let tracks: CapturedTrack[] = [];
    try {
      tracks = await s.capture.stop();
    } catch (e) {
      this.errors.set(s.meetingID, e instanceof Error ? e.message : String(e));
    }
    await s.live;
    this.set({ recording: false, paused: false, elapsed, meetingID: undefined, roles: [], processing: [...this.state.processing, s.meetingID] });
    try {
      for (const t of tracks) {
        if (t.duration <= 0) continue;
        try {
          const ref = await this.o.saveAudio(t);
          const track: MeetingTrack = { role: t.role, asset: ref, offset: s.base, duration: t.duration };
          addMeetingTrack(s.store, s.meetingID, track);
        } catch (e) {
          this.errors.set(s.meetingID, "Couldn't save the recording: " + (e instanceof Error ? e.message : String(e)));
        }
      }
      updateMeeting(s.store, s.meetingID, (m) => { m.duration = Math.max(m.duration ?? 0, elapsed); }, { name: "Recording", undoable: false });
      setMeetingStatus(s.store, s.meetingID, "processing");
    } finally {
      this.set({ processing: this.state.processing.filter((x) => x !== s.meetingID) });
    }
    await this.finalize(s.store, s.meetingID);
  }

  /** Finaler Durchlauf: jede Spur neu transkribieren (ersetzt das Live-Transkript). Ohne Transcriber: nur Status. */
  async finalize(store: WorkspaceStore, meetingID: string): Promise<void> {
    const info = meetingInfo(store, meetingID);
    const transcriber = this.o.transcriber?.();
    const tracks = info?.tracks ?? [];
    if (!info || !transcriber || tracks.length === 0 || this.state.processing.includes(meetingID)) {
      if (info && info.status !== "done") setMeetingStatus(store, meetingID, "done");
      return;
    }
    this.set({ processing: [...this.state.processing, meetingID] });
    try {
      const audio: TrackAudio[] = [];
      for (const [index, t] of tracks.entries()) {
        audio.push({ role: t.role, offset: t.offset, duration: t.duration, index, data: this.o.loadAudio ? await this.o.loadAudio(t.asset) : undefined });
      }
      const ctx = { language: info.language, vocabulary: meetingVocabulary(store, meetingID, 100) };
      const result = await transcriber.final(audio, ctx);
      const hasSystem = tracks.some((t) => t.role === "system");
      const segments = result.segments.map((sg) => withDefaultSpeaker(sg, hasSystem));
      replaceTranscript(store, meetingID, segments, transcriber.id);
      updateMeeting(store, meetingID, (m) => {
        const used = [...segments].sort((a, b) => a.s - b.s).map((x) => x.sp).filter((x): x is string => x !== undefined);
        m.speakers = mergedSpeakers(m.speakers ?? [], used);
      }, { name: "Speakers", undoable: false });
      setMeetingStatus(store, meetingID, "done");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.errors.set(meetingID, "Transcription failed: " + msg);
      updateMeeting(store, meetingID, (m) => { m.error = "Transcription failed: " + msg; }, { name: "Transcription failed", undoable: false });
      setMeetingStatus(store, meetingID, meetingTranscript(store, meetingID).length ? "done" : "failed");
    } finally {
      this.set({ processing: this.state.processing.filter((x) => x !== meetingID) });
    }
  }

  /** Zusammenfassung über die konfigurierte Engine (nur auf Nutzeraktion). */
  async summarize(store: WorkspaceStore, meetingID: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.state.summarizing.includes(meetingID)) return;
    const engine = await this.o.engine?.();
    if (!engine) {
      updateMeeting(store, meetingID, (m) => { m.summary = "unavailable"; }, { name: "Summary", undoable: false });
      return;
    }
    const prompt = buildMeetingSummaryPrompt(store, meetingID);
    if (!prompt) return;
    this.set({ summarizing: [...this.state.summarizing, meetingID] });
    updateMeeting(store, meetingID, (m) => { m.summary = "running"; }, { name: "Summary", undoable: false });
    try {
      const md = stripFence(await completeText(engine, prompt, MEETING_SUMMARY_SYSTEM, signal));
      if (md === "") throw new Error("The model returned no text.");
      applyMeetingSummary(store, meetingID, md, engine.label);
    } catch (e) {
      const msg = "Summary failed: " + (e instanceof Error ? e.message : String(e));
      updateMeeting(store, meetingID, (m) => { m.summary = "failed"; m.error = msg; }, { name: "Summary", undoable: false });
    } finally {
      this.set({ summarizing: this.state.summarizing.filter((x) => x !== meetingID) });
    }
  }

  private transcribeLive(s: Session, c: AudioChunk) {
    const t = this.o.transcriber?.();
    if (!t?.live) return;
    const hasSystem = s.capture.roles.includes("system");
    const ctx = { vocabulary: [] as string[], language: meetingInfo(s.store, s.meetingID)?.language };
    s.live = s.live.then(async () => {
      try {
        const segs = await t.live!({ ...c, offset: s.base }, ctx);
        if (segs.length) appendTranscript(s.store, s.meetingID, segs.map((x) => withDefaultSpeaker(x, hasSystem)));
      } catch (e) {
        this.set({ warning: "Live transcription: " + (e instanceof Error ? e.message : String(e)) });
      }
    });
  }

  /** Notizen, die während der Aufnahme Text bekommen, erhalten die Aufnahmezeit. */
  private onStoreChange(s: Session, c: StoreChange) {
    if (this.state.paused) return;
    const ids: string[] = [];
    for (const key of c.keys) {
      const k = parseKey(key);
      if (k.kind === "block") ids.push(k.id);
    }
    if (!ids.length) return;
    // Nach der laufenden Benachrichtigung schreiben.
    queueMicrotask(() => {
      if (this.session !== s) return;
      const time = Math.round(this.elapsed() * 100) / 100;
      for (const id of unstampedNotes(s.store, s.meetingID, ids, -Infinity, s.skip)) stampNote(s.store, id, time);
    });
  }

  private fail(store: WorkspaceStore, meetingID: string, message: string) {
    this.errors.set(meetingID, message);
    this.set({ error: message });
    updateMeeting(store, meetingID, (m) => { m.error = message; }, { name: "Meeting error", undoable: false });
  }
}

/** Mikrofon = „me“, wenn die anderen über den Systemton kommen; Systemton = „others“ (bis Sprecher getrennt sind). */
function withDefaultSpeaker(s: TranscriptSegment, hasSystem: boolean): TranscriptSegment {
  if (s.sp !== undefined) return s;
  if (s.tr === "system") return { ...s, sp: OTHERS_SPEAKER };
  if (s.tr === "microphone" && hasSystem) return { ...s, sp: ME_SPEAKER };
  return s;
}

function captureMessage(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow it for this site in the browser settings.";
  if (name === "NotFoundError") return "No microphone found.";
  return e instanceof Error ? e.message : String(e);
}
