// BSD-226: Meeting-Notizen – Datenmodell und reine Transkript-Helfer (Swift BasedCore/Model/Meeting.swift).
//
//   meeting (props.meeting = MeetingInfo, text = Titel)
//   ├─ notes   (meetingSection = "notes")   ← normale Blöcke, beim Aufnehmen mit `meetingTime` gestempelt
//   ├─ summary (meetingSection = "summary") ← von der KI geschrieben
//   └─ transcript-Chunks (props.segments, je höchstens 40 Segmente)
//
// Kurze Schlüssel der Segmente wie in Swift (`s`, `e`, `sp`, `tr`, `t`, `p`).
import type { BlockProps } from "./records.js";

export type MeetingInfo = NonNullable<BlockProps["meeting"]>;
export type TranscriptSegment = NonNullable<BlockProps["segments"]>[number];
export type MeetingStatus = MeetingInfo["status"];
export type MeetingTrack = NonNullable<MeetingInfo["tracks"]>[number];
export type MeetingSpeaker = NonNullable<MeetingInfo["speakers"]>[number];
export type MeetingContextItem = NonNullable<MeetingInfo["context"]>[number];
export type AudioTrackRole = MeetingTrack["role"];
export type MeetingSectionKind = "notes" | "summary";

/** Sprecher-ID der Mikrofonspur. */
export const ME_SPEAKER = "me";
/** Sprecher-ID der Systemaudio-Spur, bevor Sprecher getrennt wurden. */
export const OTHERS_SPEAKER = "others";

/** Ein Abschnitt des Gesprächs, den die Sprechertrennung einer Person zuordnet. */
export interface SpeakerTurn {
  start: number;
  end: number;
  speaker: string;
}

/** Aufeinanderfolgende Segmente eines Sprechers (Anzeige, Export). */
export interface TranscriptParagraph {
  id: string;
  speaker: string | undefined;
  segments: TranscriptSegment[];
  start: number;
  end: number;
  text: string;
}

/** Ein erkanntes Wort mit Zeit (Sekunden ab Beginn der transkribierten Datei). */
export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

export function speakerOf(info: MeetingInfo | undefined, id: string | undefined): MeetingSpeaker | undefined {
  return id === undefined ? undefined : info?.speakers?.find((s) => s.id === id);
}

export function speakerName(info: MeetingInfo | undefined, id: string | undefined): string {
  if (id === undefined) return "Unknown";
  const s = speakerOf(info, id);
  if (s) return s.name;
  if (id === ME_SPEAKER) return "Me";
  if (id === OTHERS_SPEAKER) return "Others";
  return id;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Segmente je `.transcript`-Record. */
export const TRANSCRIPT_CHUNK_SIZE = 40;

/** Reihenfolge: Beginn, dann ID. */
export function segmentOrder(a: TranscriptSegment, b: TranscriptSegment): number {
  if (a.s !== b.s) return a.s - b.s;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** `m:ss`, ab einer Stunde `h:mm:ss`. */
export function timecode(seconds: number): string {
  const t = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

/** `12:34`, `1:02:03` oder `[12:34]` → Sekunden; sonst `undefined`. */
export function secondsFromTimecode(text: string): number | undefined {
  const t = text.replace(/^[[\] ]+|[[\] ]+$/g, "");
  const parts = t.split(":");
  if (parts.length < 2 || parts.length > 3) return undefined;
  if (!parts.every((p) => /^\d+$/.test(p))) return undefined;
  const n = parts.map(Number);
  if (n.slice(1).some((x) => x >= 60)) return undefined;
  return n.reduce((acc, x) => acc * 60 + x, 0);
}

/** Ein Zitat `[m:ss]` im Text (Bereich in UTF-16-Indizes, `end` exklusiv). */
export interface Citation {
  start: number;
  end: number;
  seconds: number;
}

/** Zeitmarken wie `[12:34]` in einem Text – so zitiert die Zusammenfassung das Transkript. */
export function citations(text: string): Citation[] {
  const out: Citation[] = [];
  let i = 0;
  for (;;) {
    const open = text.indexOf("[", i);
    if (open < 0) break;
    const close = text.indexOf("]", open);
    if (close < 0) break;
    const s = secondsFromTimecode(text.slice(open + 1, close));
    if (s !== undefined) out.push({ start: open, end: close + 1, seconds: s });
    i = open + 1;
  }
  return out;
}

/** Text in Stücke: normaler Text und Zitate (zum Zeichnen mit Sprung-Knöpfen). */
export function splitCitations(text: string): ({ text: string } | { text: string; seconds: number })[] {
  const out: ({ text: string } | { text: string; seconds: number })[] = [];
  let pos = 0;
  for (const c of citations(text)) {
    if (c.start < pos) continue;
    if (c.start > pos) out.push({ text: text.slice(pos, c.start) });
    out.push({ text: text.slice(c.start, c.end), seconds: c.seconds });
    pos = c.end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}

/** Gruppiert Segmente desselben Sprechers (eine Lücke über `maxGap` Sekunden beginnt einen neuen Absatz). */
export function transcriptParagraphs(segments: readonly TranscriptSegment[], maxGap = 8): TranscriptParagraph[] {
  const out: TranscriptParagraph[] = [];
  for (const s of [...segments].sort(segmentOrder)) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.sp && s.s - last.end <= maxGap) {
      last.segments.push(s);
      last.end = s.e;
      last.text += " " + s.t;
    } else {
      out.push({ id: s.id, speaker: s.sp, segments: [s], start: s.s, end: s.e, text: s.t });
    }
  }
  return out;
}

const turnDistance = (t: SpeakerTurn, x: number) => (x < t.start ? t.start - x : x > t.end ? x - t.end : 0);

/**
 * Gibt jedem Segment den Sprecher mit der größten Überlappung (Ergebnis der Sprechertrennung → Transkript). Ohne
 * Überlappung: der nächste Abschnitt innerhalb von `snap` Sekunden, sonst bleibt der Sprecher. Nur Segmente der
 * Spuren `tracks` (undefined = alle), damit das Mikrofon „me“ bleibt.
 */
export function assignSpeakers(segments: readonly TranscriptSegment[], turns: readonly SpeakerTurn[],
  tracks?: ReadonlySet<AudioTrackRole>, snap = 1.5): TranscriptSegment[] {
  if (turns.length === 0) return [...segments];
  const sorted = [...turns].sort((a, b) => a.start - b.start);
  return segments.map((seg) => {
    if (tracks && seg.tr !== undefined && !tracks.has(seg.tr)) return seg;
    const overlap = new Map<string, number>();
    for (const t of sorted) {
      if (t.end > seg.s && t.start < seg.e) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + Math.min(t.end, seg.e) - Math.max(t.start, seg.s));
    }
    let best: [string, number] | undefined;
    for (const [k, v] of overlap) {
      if (!best || v > best[1] || (v === best[1] && k < best[0])) best = [k, v];
    }
    if (best) return { ...seg, sp: best[0] };
    const mid = (seg.s + seg.e) / 2;
    let nearest: SpeakerTurn | undefined;
    for (const t of sorted) if (!nearest || turnDistance(t, mid) < turnDistance(nearest, mid)) nearest = t;
    if (nearest && turnDistance(nearest, mid) <= snap) return { ...seg, sp: nearest.speaker };
    return seg;
  });
}

/** Klartext für Prompts und Export: `[0:12] Anna: …`, ein Absatz je Zeile; vorläufige Segmente fehlen. */
export function transcriptText(segments: readonly TranscriptSegment[], info: MeetingInfo | undefined, withTimecodes = true): string {
  return transcriptParagraphs(segments.filter((s) => s.p !== true))
    .map((p) => (withTimecodes ? `[${timecode(p.start)}] ` : "") + `${info ? speakerName(info, p.speaker) : p.speaker ?? "Unknown"}: ${p.text}`)
    .join("\n");
}

const fixed2 = (n: number) => n.toFixed(2);

/**
 * Erkannte Wörter → Äußerungen: eine Pause von `pause` Sekunden trennt immer, ein Satzende ab `sentenceMin` Sekunden,
 * und nichts wird länger als `maxLength`. Zeiten werden um `offset` verschoben (Beginn der Spur im Meeting).
 */
export function segmentsFromWords(words: readonly TranscriptWord[], opts: {
  offset?: number; speaker?: string | undefined; track?: AudioTrackRole | undefined; pause?: number; sentenceMin?: number; maxLength?: number; idPrefix?: string;
} = {}): TranscriptSegment[] {
  const offset = opts.offset ?? 0, pause = opts.pause ?? 0.9, sentenceMin = opts.sentenceMin ?? 4, maxLength = opts.maxLength ?? 25;
  const out: TranscriptSegment[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    const f = cur[0], l = cur[cur.length - 1];
    if (!f || !l) return;
    const text = cur.map((w) => w.text).join(" ").replaceAll(" ,", ",").replaceAll(" .", ".");
    const seg: TranscriptSegment = { id: (opts.idPrefix ?? "") + fixed2(f.start + offset), s: f.start + offset, e: l.end + offset, t: text };
    if (opts.speaker !== undefined) seg.sp = opts.speaker;
    if (opts.track !== undefined) seg.tr = opts.track;
    out.push(seg);
    cur = [];
  };
  for (const w of words) {
    if (w.text.trim() === "") continue;
    const first = cur[0], last = cur[cur.length - 1];
    if (first && last) {
      const gap = w.start - last.end;
      const sentenceEnd = /[.!?]$/.test(last.text);
      if (gap >= pause || (sentenceEnd && last.end - first.start >= sentenceMin) || w.end - first.start > maxLength) flush();
    }
    cur.push(w);
  }
  flush();
  return out;
}

/**
 * Begriffe, die die Erkennung bevorzugen soll: Namen, Abkürzungen und Produktnamen, die im Kontext vorkommen
 * (großgeschriebene Wörter, die keinen Satz beginnen, GROSSBUCHSTABEN, CamelCase). Deutsch schreibt jedes Nomen groß,
 * deshalb zählt ein einfaches großgeschriebenes Wort erst ab dem zweiten Vorkommen.
 */
export function vocabularyFromContext(text: string, limit = 60): string[] {
  const counts = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let sentenceStart = true;
  let n = 0;
  const isUpper = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();
  const isLower = (c: string) => c !== c.toUpperCase() && c === c.toLowerCase();
  const strong = (w: string) => (w.toUpperCase() === w && /\p{L}/u.test(w)) || ([...w].slice(1).some(isUpper) && [...w].some(isLower));
  for (const raw of text.split(/\s+/u)) {
    if (raw === "") continue;
    const endsSentence = /[.!?:\n]$/.test(raw);
    const word = raw.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, "");
    const atStart = sentenceStart;
    sentenceStart = endsSentence;
    if ([...word].length < 2) continue;
    const first = [...word][0]!;
    const upper = word.toUpperCase() === word && /\p{L}/u.test(word);
    const capitalised = isUpper(first);
    const inner = [...word].slice(1).some(isUpper) && [...word].some(isLower);
    if (!((upper && [...word].length <= 8) || inner || (capitalised && !atStart))) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
    if (!firstSeen.has(word)) firstSeen.set(word, n++);
  }
  return [...counts.entries()]
    .filter(([w, c]) => strong(w) || c >= 2)
    .sort((a, b) => (b[1] - a[1]) || (firstSeen.get(a[0])! - firstSeen.get(b[0])!))
    .slice(0, limit)
    .map(([w]) => w);
}
