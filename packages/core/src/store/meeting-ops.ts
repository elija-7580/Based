// BSD-226: Meeting-Operationen (Swift BasedCore/Store/MeetingOps.swift). Alles, was Records anfasst, liegt hier –
// Aufnahme und Erkennung laufen in der App. Je Operation eine Transaktion; was die Erkennung schreibt, ist nicht
// rückgängig zu machen (das Undo des Nutzers soll die Ausgabe der Erkennung nicht fressen).
import { keyBetween, keysBetween } from "../sortkeys.js";
import { plainText } from "../richtext.js";
import type { Block, BlockProps, RichText } from "../model/records.js";
import {
  ME_SPEAKER, OTHERS_SPEAKER, segmentOrder, TRANSCRIPT_CHUNK_SIZE, timecode, vocabularyFromContext,
  type MeetingContextItem, type MeetingInfo, type MeetingSectionKind, type MeetingSpeaker, type MeetingStatus, type MeetingTrack,
  type SpeakerTurn, type TranscriptSegment, type AudioTrackRole, assignSpeakers,
} from "../model/meeting.js";
import { MarkdownImporter, type MarkdownBlock } from "../interop/markdown.js";
import { MarkdownExporter } from "../interop/markdown-export.js";
import { toRichText } from "../interop/runs.js";
import { keyOf, type Tx, type WorkspaceStore } from "./store.js";

const newID = () => globalThis.crypto.randomUUID().toUpperCase();

const visibleChildren = (store: WorkspaceStore, id: string): Block[] =>
  store.children("b:" + id).map((c) => store.blocks.get(c)).filter((b): b is Block => b !== undefined && b.trashedAt === undefined);

function freshBlock(store: WorkspaceStore, type: string, parent: string, sk: string, now: number, props?: BlockProps, text?: RichText): Block {
  const b: Block = { id: newID(), type, parent, sk, createdAt: now, updatedAt: now };
  if (text !== undefined && text !== "") b.text = text;
  if (props && Object.keys(props).length > 0) b.props = props;
  if (store.userID) b.createdBy = store.userID;
  return b;
}

export function meetingTitleFor(date: Date): string {
  const d = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const t = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `Meeting notes — ${d}, ${t}`;
}

export interface CreateMeetingOptions {
  /** Elternverweis (`b:<id>` oder `w`). */
  parent: string;
  /** Sortierschlüssel; ohne: ans Ende. */
  sk?: string;
  title?: string;
  id?: string;
  info?: MeetingInfo;
  /** Ein Undo-Schritt im Store (der Editor macht Undo selbst über Yjs). */
  undoable?: boolean;
}

/** Legt einen Meeting-Block mit Notiz- und Zusammenfassungs-Abschnitt an; gibt seine ID zurück. */
export function createMeeting(store: WorkspaceStore, opts: CreateMeetingOptions): string {
  const id = opts.id ?? newID();
  store.transact("New meeting notes", (tx) => {
    const now = store.now();
    const title = opts.title ?? meetingTitleFor(new Date(Date.now()));
    const m = freshBlock(store, "meeting", opts.parent, opts.sk ?? store.endKey(opts.parent), now, { meeting: opts.info ?? { status: "ready" } }, title);
    m.id = id;
    tx.put({ kind: "block", data: m });
    const keys = keysBetween(2, undefined, undefined);
    (["notes", "summary"] as const).forEach((kind, i) => {
      tx.put({ kind: "block", data: freshBlock(store, "meetingSection", "b:" + id, keys[i]!, now, { meetingSection: kind }) });
    });
  }, { undoable: opts.undoable ?? true });
  return id;
}

export function meetingInfo(store: WorkspaceStore, id: string): MeetingInfo | undefined {
  const b = store.blocks.get(id);
  return b?.type === "meeting" ? b.props?.meeting ?? { status: "ready" } : undefined;
}

/**
 * BSD-407 Teil 3: Hat die Seite (direkt, ohne Unterseiten) einen Meeting-Block? Der Block-Editor kann Meetings noch
 * nicht bearbeiten (BSD-407 Teil 2f); solche Seiten öffnet die Hülle bis dahin im alten Editor.
 */
export function pageHasMeeting(store: WorkspaceStore, pageID: string): boolean {
  const stack = [...store.children("b:" + pageID)];
  for (let n = 0; stack.length && n < 100_000; n++) {
    const b = store.blocks.get(stack.pop()!);
    if (!b || b.trashedAt !== undefined || b.type === "page" || b.type === "databasePage") continue;
    if (b.type === "meeting") return true;
    stack.push(...store.children("b:" + b.id));
  }
  return false;
}

/** Das Meeting, zu dem ein Block gehört (es selbst, ein Abschnitt, eine Notiz darin oder ein Transkript-Chunk). */
export function meetingContaining(store: WorkspaceStore, id: string): string | undefined {
  let cur: string | undefined = id;
  for (let n = 0; cur && n < 10_000; n++) {
    const b = store.blocks.get(cur);
    if (!b) return undefined;
    if (b.type === "meeting") return b.id;
    if (!b.parent.startsWith("b:")) return undefined;
    cur = b.parent.slice(2);
  }
  return undefined;
}

/** Abschnitt (Notizen/Zusammenfassung), falls vorhanden. */
export function findMeetingSection(store: WorkspaceStore, meeting: string, kind: MeetingSectionKind): string | undefined {
  return visibleChildren(store, meeting).find((b) => b.type === "meetingSection" && b.props?.meetingSection === kind)?.id;
}

/** Abschnitt, bei Bedarf angelegt (Meetings ohne ihn, z. B. aus älteren Versionen). */
export function meetingSection(store: WorkspaceStore, meeting: string, kind: MeetingSectionKind): string {
  const found = findMeetingSection(store, meeting, kind);
  if (found) return found;
  let id = "";
  store.transact("Add section", (tx) => {
    const kids = store.children("b:" + meeting);
    const first = kids[0] ? store.blocks.get(kids[0])?.sk : undefined;
    const last = kids.length ? store.blocks.get(kids[kids.length - 1]!)?.sk : undefined;
    const sk = kind === "notes" ? keyBetween(undefined, first) : keyBetween(last, undefined);
    const b = freshBlock(store, "meetingSection", "b:" + meeting, sk, store.now(), { meetingSection: kind });
    id = b.id;
    tx.put({ kind: "block", data: b });
  }, { undoable: false });
  return id;
}

export function transcriptChunks(store: WorkspaceStore, meeting: string): Block[] {
  return visibleChildren(store, meeting).filter((b) => b.type === "transcript");
}

/** Das ganze Transkript, nach Zeit. */
export function meetingTranscript(store: WorkspaceStore, meeting: string, includePartial = true): TranscriptSegment[] {
  return transcriptChunks(store, meeting).flatMap((c) => c.props?.segments ?? [])
    .filter((s) => includePartial || s.p !== true)
    .sort(segmentOrder);
}

// MARK: Meeting-Info

export function updateMeeting(store: WorkspaceStore, id: string, f: (m: MeetingInfo) => void, opts: { name?: string; undoable?: boolean } = {}) {
  if (store.blocks.get(id)?.type !== "meeting") return;
  store.transact(opts.name ?? "Edit meeting", (tx) => {
    tx.update(id, (b) => {
      const info = structuredClone(b.props?.meeting ?? { status: "ready" as const });
      f(info);
      b.props = { ...(b.props ?? {}), meeting: info };
    });
  }, { undoable: opts.undoable ?? true });
}

export function setMeetingStatus(store: WorkspaceStore, id: string, status: MeetingStatus) {
  const now = store.now();
  updateMeeting(store, id, (m) => {
    if (status === "recording" && m.startedAt === undefined) m.startedAt = now;
    if ((status === "processing" || status === "done") && m.endedAt === undefined) m.endedAt = now;
    if (status !== "failed") delete m.error;
    m.status = status;
  }, { name: "Meeting status", undoable: false });
}

export function addMeetingTrack(store: WorkspaceStore, id: string, track: MeetingTrack) {
  updateMeeting(store, id, (m) => {
    m.tracks = [...(m.tracks ?? []), track];
    m.duration = Math.max(m.duration ?? 0, track.offset + (track.duration ?? 0));
  }, { name: "Add recording", undoable: false });
}

export function setMeetingTitle(store: WorkspaceStore, id: string, title: string) {
  store.transact("Rename meeting", (tx) => tx.update(id, (b) => {
    if (title === "") delete b.text;
    else b.text = title;
  }), { coalesce: "meeting-title-" + id });
}

// MARK: Transkript

/**
 * Segmente einer Live-Erkennung hinzufügen oder ersetzen: gleiche ID ersetzt (vorläufig → endgültig), neue kommen in
 * den letzten Chunk, alle 40 Segmente beginnt ein neuer. Leerer Text entfernt das Segment mit dieser ID. Es wird nur
 * der betroffene (kleine) Chunk neu geschrieben.
 */
export function appendTranscript(store: WorkspaceStore, meeting: string, incoming: readonly TranscriptSegment[]) {
  if (incoming.length === 0 || store.blocks.get(meeting)?.type !== "meeting") return;
  store.transact("Transcribe", (tx) => {
    const now = store.now();
    const chunks = transcriptChunks(store, meeting).map((c) => structuredClone(c));
    const fresh = new Set<number>();
    const location = new Map<string, number>();
    for (let ci = chunks.length - 1; ci >= 0; ci--) {
      for (const s of chunks[ci]!.props?.segments ?? []) if (!location.has(s.id)) location.set(s.id, ci);
    }
    const dirty = new Set<number>();
    const segsOf = (ci: number) => (chunks[ci]!.props ??= {}).segments ??= [];
    for (const seg of incoming) {
      const remove = seg.t.trim() === "";
      const at = location.get(seg.id);
      if (at !== undefined) {
        const segs = segsOf(at);
        const i = segs.findIndex((s) => s.id === seg.id);
        if (remove) {
          if (i >= 0) segs.splice(i, 1);
          location.delete(seg.id);
        } else if (i >= 0) segs[i] = seg;
        else segs.push(seg);
        dirty.add(at);
        continue;
      }
      if (remove) continue;
      const lastChunk = chunks[chunks.length - 1];
      if (!lastChunk || (lastChunk.props?.segments?.length ?? 0) >= TRANSCRIPT_CHUNK_SIZE) {
        const kids = store.children("b:" + meeting);
        const after = lastChunk?.sk ?? (kids.length ? store.blocks.get(kids[kids.length - 1]!)?.sk : undefined);
        chunks.push(freshBlock(store, "transcript", "b:" + meeting, keyBetween(after, undefined), now, { segments: [] }));
        fresh.add(chunks.length - 1);
      }
      const ci = chunks.length - 1;
      segsOf(ci).push(seg);
      location.set(seg.id, ci);
      dirty.add(ci);
    }
    for (const ci of [...dirty].sort((a, b) => a - b)) {
      const c = chunks[ci]!;
      const segs = [...(c.props?.segments ?? [])].sort(segmentOrder);
      if (fresh.has(ci)) {
        c.props = { ...(c.props ?? {}), segments: segs };
        tx.put({ kind: "block", data: c });
      } else tx.update(c.id, (b) => { b.props = { ...(b.props ?? {}), segments: segs }; });
    }
    const ends = incoming.filter((s) => s.t !== "").map((s) => s.e);
    if (ends.length) {
      const end = Math.max(...ends);
      tx.update(meeting, (b) => {
        const m = structuredClone(b.props?.meeting ?? { status: "ready" as const });
        m.duration = Math.max(m.duration ?? 0, end);
        b.props = { ...(b.props ?? {}), meeting: m };
      });
    }
  }, { undoable: false });
}

/** Ersetzt das ganze Transkript (finaler Durchlauf nach der Aufnahme). */
export function replaceTranscript(store: WorkspaceStore, meeting: string, segments: readonly TranscriptSegment[], engine?: string) {
  if (store.blocks.get(meeting)?.type !== "meeting") return;
  store.transact("Transcript", (tx) => {
    const now = store.now();
    const old = transcriptChunks(store, meeting);
    for (const c of old) tx.remove(keyOf("block", c.id));
    const sorted = [...segments].sort(segmentOrder);
    const parts: TranscriptSegment[][] = [];
    for (let i = 0; i < sorted.length; i += TRANSCRIPT_CHUNK_SIZE) parts.push(sorted.slice(i, i + TRANSCRIPT_CHUNK_SIZE));
    const kids = store.children("b:" + meeting).filter((id) => !old.some((c) => c.id === id));
    const after = kids.length ? store.blocks.get(kids[kids.length - 1]!)?.sk : undefined;
    const keys = keysBetween(parts.length, after, undefined);
    parts.forEach((part, i) => tx.put({ kind: "block", data: freshBlock(store, "transcript", "b:" + meeting, keys[i]!, now, { segments: part }) }));
    tx.update(meeting, (b) => {
      const m = structuredClone(b.props?.meeting ?? { status: "ready" as const });
      if (engine !== undefined) m.engine = engine;
      if (sorted.length) m.duration = Math.max(m.duration ?? 0, ...sorted.map((s) => s.e));
      b.props = { ...(b.props ?? {}), meeting: m };
    });
  }, { undoable: false });
}

/** Segmente an Ort und Stelle ändern; `f` liefert `undefined`, um eines zu entfernen. */
export function editTranscript(store: WorkspaceStore, meeting: string, f: (s: TranscriptSegment) => TranscriptSegment | undefined, name = "Edit transcript") {
  store.transact(name, (tx) => {
    for (const c of transcriptChunks(store, meeting)) {
      const old = c.props?.segments ?? [];
      const next = old.map(f).filter((s): s is TranscriptSegment => s !== undefined);
      if (JSON.stringify(next) !== JSON.stringify(old)) tx.update(c.id, (b) => { b.props = { ...(b.props ?? {}), segments: next }; });
    }
  });
}

export function setSegmentSpeaker(store: WorkspaceStore, meeting: string, segmentIDs: readonly string[], speaker: string) {
  const ids = new Set(segmentIDs);
  editTranscript(store, meeting, (s) => (ids.has(s.id) ? { ...s, sp: speaker } : s), "Change speaker");
}

/** Bekannte Sprecher plus ein Standard-Eintrag je benutzter ID, in der Reihenfolge des ersten Auftretens. */
export function mergedSpeakers(known: readonly MeetingSpeaker[], used: readonly string[]): MeetingSpeaker[] {
  const out = [...known];
  const seen = new Set(known.map((s) => s.id));
  const palette = ["blue", "orange", "green", "purple", "pink", "brown", "red", "yellow", "gray"] as const;
  let n = known.filter((s) => s.isMe !== true).length;
  for (const id of used) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === ME_SPEAKER) {
      out.unshift({ id, name: "Me", isMe: true, color: "default" });
      continue;
    }
    n += 1;
    out.push({ id, name: id === OTHERS_SPEAKER ? "Others" : `Speaker ${n}`, color: palette[(n - 1) % palette.length]! });
  }
  return out;
}

/** Ergebnis einer Sprechertrennung anwenden: Segmente der Spuren `tracks` bekommen den Sprecher des Abschnitts. */
export function applySpeakerTurns(store: WorkspaceStore, meeting: string, turns: readonly SpeakerTurn[], tracks?: ReadonlySet<AudioTrackRole>) {
  const segs = assignSpeakers(meetingTranscript(store, meeting), turns, tracks);
  const byID = new Map(segs.map((s) => [s.id, s]));
  store.transact("Separate speakers", (tx) => {
    for (const c of transcriptChunks(store, meeting)) {
      const old = c.props?.segments ?? [];
      const next = old.map((s) => byID.get(s.id) ?? s);
      if (JSON.stringify(next) !== JSON.stringify(old)) tx.update(c.id, (b) => { b.props = { ...(b.props ?? {}), segments: next }; });
    }
    tx.update(meeting, (b) => {
      const m = structuredClone(b.props?.meeting ?? { status: "ready" as const });
      m.speakers = mergedSpeakers(m.speakers ?? [], segs.map((s) => s.sp).filter((s): s is string => s !== undefined));
      b.props = { ...(b.props ?? {}), meeting: m };
    });
  });
}

export function renameSpeaker(store: WorkspaceStore, meeting: string, speaker: string, name: string) {
  const clean = name.trim();
  if (clean === "") return;
  updateMeeting(store, meeting, (m) => {
    const list = [...(m.speakers ?? [])];
    const i = list.findIndex((s) => s.id === speaker);
    if (i >= 0) list[i] = { ...list[i]!, name: clean };
    else list.push({ id: speaker, name: clean });
    m.speakers = list;
  }, { name: "Rename speaker" });
}

/** Zwei Bezeichnungen sind dieselbe Person: `from` wird überall zu `into`. */
export function mergeSpeakers(store: WorkspaceStore, meeting: string, from: string, into: string) {
  if (from === into) return;
  store.transact("Merge speakers", (tx) => {
    for (const c of transcriptChunks(store, meeting)) {
      const old = c.props?.segments ?? [];
      if (!old.some((s) => s.sp === from)) continue;
      tx.update(c.id, (b) => { b.props = { ...(b.props ?? {}), segments: old.map((s) => (s.sp === from ? { ...s, sp: into } : s)) }; });
    }
    tx.update(meeting, (b) => {
      const m = structuredClone(b.props?.meeting ?? { status: "ready" as const });
      if (m.speakers) m.speakers = m.speakers.filter((s) => s.id !== from);
      b.props = { ...(b.props ?? {}), meeting: m };
    });
  });
}

// MARK: Notizen

/** Merkt sich an einer Notiz die Aufnahmezeit, zu der sie geschrieben wurde (Klick → ab da abspielen). */
export function stampNote(store: WorkspaceStore, id: string, time: number) {
  const b = store.blocks.get(id);
  if (!b || b.props?.meetingTime !== undefined) return;
  store.transact("Note time", (tx) => tx.update(id, (x) => { x.props = { ...(x.props ?? {}), meetingTime: time }; }), { undoable: false });
}

/** Typen, deren Text Notizen sind (Swift `isTextEditable`). */
const NOTE_TYPES = new Set(["text", "heading1", "heading2", "heading3", "heading4", "bulletedList", "numberedList", "todo", "toggle", "quote", "callout", "code"]);

/**
 * Notizen dieses Meetings unter `ids`, die noch keine Zeit tragen, nicht leer sind und nach `since` (Swift-Datum)
 * angelegt wurden – die stempelt der Aufnahmedienst mit der aktuellen Aufnahmezeit.
 */
export function unstampedNotes(store: WorkspaceStore, meeting: string, ids: Iterable<string>, since: number, skip?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const b = store.blocks.get(id);
    if (!b || b.trashedAt !== undefined || b.props?.meetingTime !== undefined || !NOTE_TYPES.has(b.type)) continue;
    if (skip?.has(id) || b.createdAt < since || plainText(b.text).trim() === "") continue;
    if (meetingContaining(store, id) !== meeting) continue;
    const notes = findMeetingSection(store, meeting, "notes");
    if (!notes || !isUnder(store, id, notes)) continue;
    out.push(id);
  }
  return out;
}

function isUnder(store: WorkspaceStore, id: string, ancestor: string): boolean {
  let p = store.blocks.get(id)?.parent;
  for (let n = 0; p?.startsWith("b:") && n < 10_000; n++) {
    const up = p.slice(2);
    if (up === ancestor) return true;
    p = store.blocks.get(up)?.parent;
  }
  return false;
}

/** Notizen mit Zeitstempel, nach Zeit (für „In the recording“). */
export function stampedNotes(store: WorkspaceStore, meeting: string): { id: string; time: number; text: string }[] {
  const section = findMeetingSection(store, meeting, "notes");
  if (!section) return [];
  return store.descendants(section).map((id) => store.blocks.get(id))
    .filter((b): b is Block => b !== undefined && b.trashedAt === undefined && b.props?.meetingTime !== undefined && plainText(b.text).trim() !== "")
    .map((b) => ({ id: b.id, time: b.props!.meetingTime!, text: plainText(b.text).trim() }))
    .sort((a, b) => a.time - b.time);
}

/** Klartext des Notiz-Abschnitts, mit Aufnahmezeit, wo eine Notiz gestempelt ist. */
export function meetingNotesText(store: WorkspaceStore, meeting: string): string {
  const section = findMeetingSection(store, meeting, "notes");
  if (!section) return "";
  const out: string[] = [];
  for (const id of store.descendants(section)) {
    const b = store.blocks.get(id);
    if (!b || b.trashedAt !== undefined) continue;
    const t = plainText(b.text).trim();
    if (t === "") continue;
    out.push((b.props?.meetingTime !== undefined ? `[${timecode(b.props.meetingTime)}] ` : "") + t);
  }
  return out.join("\n");
}

// MARK: Kontext

export function addMeetingContext(store: WorkspaceStore, meeting: string, item: Omit<MeetingContextItem, "id"> & { id?: string }) {
  updateMeeting(store, meeting, (m) => {
    if (item.kind === "page" && m.context?.some((c) => c.kind === "page" && c.pageID === item.pageID)) return;
    m.context = [...(m.context ?? []), { ...item, id: item.id ?? newID() } as MeetingContextItem];
  }, { name: "Add context" });
}

export function removeMeetingContext(store: WorkspaceStore, meeting: string, itemID: string) {
  updateMeeting(store, meeting, (m) => {
    if (m.context) m.context = m.context.filter((c) => c.id !== itemID);
  }, { name: "Remove context" });
}

/** Text von allem, was als Kontext angehängt ist (verlinkte Seiten als Markdown), höchstens `limit` Zeichen. */
export function meetingContextText(store: WorkspaceStore, meeting: string, limit = 40_000): string {
  const info = meetingInfo(store, meeting);
  if (!info) return "";
  const parts: string[] = [];
  if (info.attendees?.length) parts.push("Attendees: " + info.attendees.join(", "));
  const exporter = new MarkdownExporter(store);
  for (const item of info.context ?? []) {
    switch (item.kind) {
      case "page":
        if (item.pageID && store.blocks.has(item.pageID)) parts.push(exporter.export(item.pageID));
        break;
      case "text":
        if (item.text) parts.push(item.text);
        break;
      case "url":
        parts.push([item.title, item.text].filter((x) => x !== undefined).join(" — "));
        break;
      case "file":
        parts.push("File: " + (item.title ?? item.asset?.name ?? "") + (item.text !== undefined ? "\n" + item.text : ""));
        break;
    }
  }
  const joined = parts.join("\n\n");
  return joined.length > limit ? joined.slice(0, limit) : joined;
}

/** Begriffe für Erkennung und Zusammenfassung: Vokabular, Teilnehmer, benannte Sprecher, Kontextseiten, Namen im Kontext. */
export function meetingVocabulary(store: WorkspaceStore, meeting: string, limit = 100): string[] {
  const info = meetingInfo(store, meeting);
  if (!info) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (w: string) => {
    const t = w.trim();
    if (t === "" || t.length > 60 || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  (info.vocabulary ?? []).forEach(add);
  (info.attendees ?? []).forEach(add);
  (info.speakers ?? []).filter((s) => !s.name.startsWith("Speaker ") && s.isMe !== true && s.id !== OTHERS_SPEAKER).forEach((s) => add(s.name));
  for (const item of info.context ?? []) {
    if (item.kind === "page" && item.pageID) {
      const t = plainText(store.blocks.get(item.pageID)?.text).trim();
      if (t) add(t);
    }
  }
  vocabularyFromContext(meetingContextText(store, meeting)).forEach(add);
  return out.slice(0, limit);
}

// MARK: Zusammenfassung

/** Von der KI geschriebenes Markdown in den Zusammenfassungs-Abschnitt (ersetzt den bisherigen Inhalt). */
export function applyMeetingSummary(store: WorkspaceStore, meeting: string, markdown: string, engine?: string) {
  const section = meetingSection(store, meeting, "summary");
  const items = new MarkdownImporter({ lenient: true }).parse(markdown);
  store.transact("Meeting summary", (tx) => {
    const now = store.now();
    for (const id of [...store.descendants(section)].reverse()) {
      const b = store.blocks.get(id);
      if (!b) continue;
      if (b.type === "page" || b.type === "databasePage") {
        if (b.trashedAt === undefined) tx.update(id, (x) => { x.trashedAt = now; });
      } else if (!store.descendants(id).some((d) => store.blocks.get(d)?.type === "page")) tx.remove(keyOf("block", id));
    }
    insertMarkdown(store, tx, items, "b:" + section, now);
    tx.update(meeting, (b) => {
      const m = structuredClone(b.props?.meeting ?? { status: "ready" as const });
      m.summary = "done";
      if (engine !== undefined) m.summaryEngine = engine;
      else delete m.summaryEngine;
      if (m.error?.startsWith("Summary failed")) delete m.error;
      b.props = { ...(b.props ?? {}), meeting: m };
    });
  }, { undoable: false });
}

function insertMarkdown(store: WorkspaceStore, tx: Tx, items: readonly MarkdownBlock[], parent: string, now: number) {
  const keys = keysBetween(items.length, undefined, undefined);
  items.forEach((it, i) => {
    const props: BlockProps = { ...it.props };
    if (it.linkTarget !== undefined) props.linkTarget = it.linkTarget;
    const b = freshBlock(store, it.type, parent, keys[i]!, now, props, toRichText(it.text));
    tx.put({ kind: "block", data: b });
    if (it.children.length) insertMarkdown(store, tx, it.children, "b:" + b.id, now);
  });
}

/** Text des Zusammenfassungs-Abschnitts (für Zitate „Jump to“). */
export function meetingSummaryTexts(store: WorkspaceStore, meeting: string): string[] {
  const section = findMeetingSection(store, meeting, "summary");
  if (!section) return [];
  return store.descendants(section).map((id) => store.blocks.get(id)).filter((b): b is Block => b !== undefined && b.trashedAt === undefined)
    .map((b) => plainText(b.text)).filter((t) => t !== "");
}
