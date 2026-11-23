// BSD-407 Teil 5: Meeting-Block im Block-Editor (ADR 0016). Gleiche Records wie der alte Editor (BSD-226): der Block
// trägt `props.meeting` und den Titel, darunter die Abschnitte „notes“ und „summary“ (normale Blöcke, die der Editor
// selbst zeichnet – `renderSection`) und die Transkript-Chunks. Aufnahme, Wiedergabe und Zusammenfassung kommen über
// den MeetingHost der App; ohne Host ist der Block nur lesbar. Logik (Records, Zeitstempel, Sprecher) liegt im Kern
// und in @based/brain, hier nur die Ansicht. Hänger-Breadcrumbs (BSD-418) mit festen Namen, nie mit Inhalten.
import {
  addMeetingContext, citations, findMeetingSection, meetingInfo, meetingSection, meetingSummaryTexts, meetingTranscript, mergeSpeakers,
  noteBreadcrumb, plainText, removeMeetingContext, renameSpeaker, setMeetingTitle, speakerName, speakerOf, stampedNotes, timecode,
  transcriptChunks, transcriptParagraphs, updateMeeting, type MeetingInfo, type TranscriptParagraph, type WorkspaceStore,
} from "@based/core";
import { BasedButton, BasedField, BasedMenu, BasedTabs, BasedToken, tokenColor } from "@based/ui/astryx";
import { useEffect, useId, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { usePageRef, useStoreRevision, type PageDirectory, type PageRef } from "../ui/env.js";
import type { MeetingHost, MeetingHostState } from "../ui/meetingHost.js";
import "../meeting.css";
import "./meeting.css";

type Tab = "summary" | "notes" | "transcript";
const TABS: { id: Tab; label: string }[] = [{ id: "summary", label: "Summary" }, { id: "notes", label: "Notes" }, { id: "transcript", label: "Transcript" }];

const IDLE: MeetingHostState = {
  meetingID: undefined, recording: false, paused: false, elapsed: 0, roles: [], processing: [], summarizing: [], error: undefined, warning: undefined, playback: undefined, transcription: "off",
};
const noSubscribe = () => () => undefined;
const idle = () => IDLE;

function useHost(host: MeetingHost | undefined): MeetingHostState {
  return useSyncExternalStore(host ? host.subscribe : noSubscribe, host ? host.getState : idle);
}

export interface MeetingBlockProps {
  id: string;
  store: WorkspaceStore;
  editable: boolean;
  host: MeetingHost | undefined;
  pages: PageDirectory | undefined;
  onOpenPage: ((pageID: string) => void) | undefined;
  /** Blöcke eines Abschnitts (Notizen, Zusammenfassung), vom Editor gezeichnet und bearbeitbar. */
  renderSection: (sectionID: string, placeholder: string | undefined) => ReactNode;
}

/** Feste Namen für die Hänger-Breadcrumbs (BSD-418): was getan wurde, nie Titel, Notizen oder Transkript. */
export const MEETING_BREADCRUMBS = ["meeting start", "meeting pause", "meeting resume", "meeting stop", "meeting summarize", "meeting play", "meeting stop playback", "meeting tab", "meeting transcribe now"] as const;
const crumb = (name: (typeof MEETING_BREADCRUMBS)[number]) => noteBreadcrumb(name);

export function MeetingBlock(props: MeetingBlockProps) {
  const { store, host, editable, id } = props;
  useStoreRevision(store);
  const hs = useHost(host);
  const [tab, setTab] = useState<Tab | undefined>();
  const [systemAudio, setSystemAudio] = useState(false);
  const panelID = useId();
  const block = store.blocks.get(id);
  const info: MeetingInfo = meetingInfo(store, id) ?? { status: "ready" };
  const notesID = findMeetingSection(store, id, "notes");
  const summaryID = findMeetingSection(store, id, "summary");

  // Meetings ohne Abschnitte (ältere Versionen, Import): Abschnitte anlegen – wie der alte Editor, nicht rückgängig.
  useEffect(() => {
    if (!editable || store.blocks.get(id)?.type !== "meeting") return;
    if (!store.blocks.get(id)?.props?.meeting) updateMeeting(store, id, () => undefined, { name: "Meeting", undoable: false });
    if (!findMeetingSection(store, id, "notes")) meetingSection(store, id, "notes");
    if (!findMeetingSection(store, id, "summary")) meetingSection(store, id, "summary");
  }, [editable, store, id]);

  if (!block) return null;
  const recordingHere = hs.recording && hs.meetingID === id;
  const busyElsewhere = hs.recording && hs.meetingID !== id;
  const processing = hs.processing.includes(id);
  const summarizing = hs.summarizing.includes(id);
  const segments = meetingTranscript(store, id);
  const hasTracks = (info.tracks?.length ?? 0) > 0;
  const summaryBlocks = summaryID ? store.children("b:" + summaryID).filter((c) => store.blocks.get(c)?.trashedAt === undefined).length : 0;
  // Ohne KI in diesem Build (Beta) kein Reiter „Summary“ – außer das Meeting hat schon eine Zusammenfassung.
  const tabs = host?.summaryAvailable?.() === false && summaryBlocks === 0 ? TABS.filter((t) => t.id !== "summary") : TABS;
  const wanted: Tab = tab ?? (recordingHere ? "notes" : summaryBlocks > 0 ? "summary" : transcriptChunks(store, id).length > 0 ? "transcript" : "notes");
  const current: Tab = tabs.some((t) => t.id === wanted) ? wanted : "notes";
  const play = (s: number) => {
    crumb("meeting play");
    host?.play(store, id, s);
  };
  const playback = hs.playback?.meetingID === id ? hs.playback : undefined;
  const error = info.error ?? host?.errorFor(id) ?? (recordingHere ? hs.error : undefined);
  const speakers = new Set(meetingTranscript(store, id, false).map((s) => s.sp).filter((s) => s !== undefined)).size;
  const meta = [
    info.startedAt !== undefined ? new Date(978_307_200_000 + info.startedAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : undefined,
    info.duration ? timecode(info.duration) : undefined,
    speakers > 0 ? `${speakers} speaker${speakers === 1 ? "" : "s"}` : undefined,
  ].filter((x) => x !== undefined);
  const canRecord = host !== undefined && editable && host.canRecord();
  const start = () => {
    if (!host) return;
    crumb("meeting start");
    setTab("notes");
    void host.start(store, id, { systemAudio });
  };
  const notesHaveText = notesID !== undefined && store.descendants(notesID).some((d) => plainText(store.blocks.get(d)?.text).trim() !== "");

  return (
    <div className="bx-meet bx2-meet" data-embed="" data-testid="meeting-block" data-status={info.status} data-recording={recordingHere ? "true" : undefined}>
      <div className="bx-meet-head">
        <span className="bx-meet-icon" data-live={recordingHere && !hs.paused ? "true" : undefined} aria-hidden>●</span>
        <TitleField store={store} id={id} title={plainText(block.text)} editable={editable} />
        <LiveStatus hs={hs} host={host} recording={recordingHere} processing={processing} pending={info.transcribePending === true && !processing && !recordingHere} />
      </div>

      <div className="bx-meet-controls">
        {recordingHere ? (
          <>
            <BasedButton label={hs.paused ? "Resume" : "Pause"} onClick={() => {
              crumb(hs.paused ? "meeting resume" : "meeting pause");
              if (hs.paused) host?.resume();
              else host?.pause();
            }} />
            <BasedButton label="Stop" variant="primary" onClick={() => {
              crumb("meeting stop");
              void host?.stop();
            }} />
            <span className="bx-meet-muted">{hs.paused ? "Paused" : hs.roles.includes("system") ? "Microphone + shared audio" : "Microphone"}</span>
          </>
        ) : (
          <>
            {canRecord ? (
              <BasedButton label={hasTracks ? "Continue recording" : host.hasTranscriber() ? "Start transcribing" : "Start recording"} variant="primary"
                disabled={busyElsewhere || processing} onClick={start} />
            ) : null}
            {canRecord && host.canCaptureSystemAudio() ? (
              <label className="bx-meet-check" title="Your browser asks which tab or screen to share; tick “Share audio” there.">
                <input type="checkbox" checked={systemAudio} onChange={(e) => setSystemAudio(e.target.checked)} /> Include tab or system audio
              </label>
            ) : null}
            {busyElsewhere ? <span className="bx-meet-muted">Another meeting is recording.</span> : null}
            {!host || !host.canRecord() ? <span className="bx-meet-muted">{host ? "Recording isn't available in this browser." : "Recording works in the Based app."}</span> : null}
            {/* Ohne Transkript gab es keinen Weg, die Aufnahme anzuhören (Abspielen hing nur an Transkript-Zeilen). */}
            {hasTracks && host && !playback ? (
              <BasedButton label="Play recording" disabled={busyElsewhere} onClick={() => play(0)} />
            ) : null}
            {playback ? (
              <span className="bx-meet-playing bx2-meet-playing" data-testid="meeting-playback" data-from={playback.from}>
                {playback.error ? <span className="bx-meet-error">{playback.error}</span> : <span>{playback.playing ? "Playing" : "Paused"} · <span className="bx-meet-clock">{timecode(playback.position)}</span></span>}
                <BasedButton label="Stop" ariaLabel="Stop playback" variant="ghost" onClick={() => {
                  crumb("meeting stop playback");
                  host?.stopPlayback();
                }} />
              </span>
            ) : null}
          </>
        )}
      </div>

      {recordingHere && info.consentNotice !== false ? (
        <div className="bx-meet-banner" role="note">Let everyone know this conversation is being recorded{host?.hasTranscriber() ? " and transcribed" : ""}.</div>
      ) : null}
      {recordingHere && hs.warning ? <div className="bx-meet-banner" role="status">{hs.warning}</div> : null}
      <div className="bx-meet-status">
        {meta.length ? <span>{meta.join(" · ")}</span> : null}
        {info.transcribePending && !processing && !recordingHere ? (
          <span className="bx-meet-pending" data-testid="meeting-transcribe-pending">
            Recording saved · transcript {host?.pendingReason?.() ?? "comes later"}
            {host?.transcribeNow && editable ? (
              <BasedButton label="Transcribe now" variant="ghost" onClick={() => {
                crumb("meeting transcribe now");
                void host.transcribeNow?.(store, id);
              }} />
            ) : null}
          </span>
        ) : null}
        {summarizing ? <span>Writing summary…</span> : null}
        {error ? <span className="bx-meet-error" role="alert">{error}</span> : null}
      </div>

      <ContextBar store={store} pages={props.pages} onOpenPage={props.onOpenPage} id={id} info={info} editable={editable} />

      <div className="bx2-meet-tabs">
        <BasedTabs label="Meeting" value={current} tabs={tabs.map((t) => ({ ...t, panelId: panelID }))} onChange={(v) => {
          crumb("meeting tab");
          setTab(v as Tab);
        }} />
      </div>

      <div className="bx-meet-body" role="tabpanel" id={panelID} aria-label={TABS.find((t) => t.id === current)!.label}>
        {current === "notes" ? (
          <>
            {notesID ? props.renderSection(notesID, editable ? "Type notes…" : "No notes.") : <span className="bx-meet-muted">No notes.</span>}
            {recordingHere ? <p className="bx-meet-hint">Type notes — each one is linked to the moment in the recording.</p> : null}
            <StampedNotes store={store} id={id} disabled={!hasTracks || !host} onPlay={play} />
          </>
        ) : current === "summary" ? (
          <SummaryTab store={store} id={id} info={info} summaryID={summaryID} count={summaryBlocks} host={host} summarizing={summarizing} editable={editable}
            disabled={!hasTracks || !host} onPlay={play} hasContent={segments.length > 0 || notesHaveText} renderSection={props.renderSection} />
        ) : (
          <TranscriptTab store={store} id={id} info={info} editable={editable} recording={recordingHere} mode={hs.transcription} processing={processing} host={host} disabled={!hasTracks || !host} onPlay={play} playingFrom={playback?.from} />
        )}
      </div>
    </div>
  );
}

/**
 * Feedback 18. 11.: Im Block war nicht zu sehen, ob gerade transkribiert wird. Die Anzeige oben rechts sagt es immer
 * ausdrücklich – mit pulsierendem Punkt nur, solange wirklich etwas läuft – und nennt, wann das Transkript kommt,
 * wenn es nicht live entsteht (Whisper auf dem Server transkribiert erst nach dem Stop).
 */
export function liveStatus(o: { recording: boolean; paused: boolean; processing: boolean; pending: boolean; transcription: MeetingHostState["transcription"]; pendingReason?: string | undefined }):
  { state: "live" | "recording" | "paused" | "processing" | "pending"; label: string; detail?: string } | undefined {
  if (o.recording) {
    if (o.paused) return { state: "paused", label: "Paused", detail: "Not recording" };
    switch (o.transcription) {
      case "live": return { state: "live", label: "Transcribing" };
      case "after": return { state: "recording", label: "Recording", detail: "Transcript when you stop" };
      case "deferred": return { state: "recording", label: "Recording", detail: `Transcript ${whenLater(o.pendingReason)}` };
      case "off": return { state: "recording", label: "Recording", detail: "No transcription set up" };
      default: return { state: "recording", label: "Recording" };
    }
  }
  if (o.processing) return { state: "processing", label: "Transcribing…" };
  if (o.pending) return { state: "pending", label: "Not transcribed yet" };
  return undefined;
}

/** „when this device is plugged in“ bleibt, der allgemeine Grund („comes later“) wird zu „later“. */
const whenLater = (reason: string | undefined) => (!reason || reason === "comes later" ? "later" : reason);

function LiveStatus(props: { hs: MeetingHostState; host: MeetingHost | undefined; recording: boolean; processing: boolean; pending: boolean }) {
  const { hs, host } = props;
  const s = liveStatus({
    recording: props.recording, paused: hs.paused, processing: props.processing, pending: props.pending, transcription: hs.transcription,
    pendingReason: hs.transcription === "deferred" ? host?.pendingReason?.() : undefined,
  });
  if (!s) return null;
  return (
    <span className="bx2-meet-live" role="status" aria-live="polite" data-testid="meeting-live-status" data-state={s.state}>
      <span className="bx2-meet-live-dot" aria-hidden />
      <span className="bx2-meet-live-label">{s.label}</span>
      {props.recording ? <span className="bx-meet-clock" aria-label="Recording time" data-testid="meeting-clock">{timecode(hs.elapsed)}</span> : null}
      {s.detail ? <span className="bx2-meet-live-detail">{s.detail}</span> : null}
    </span>
  );
}

/** Zeitmarke: spielt die Aufnahme ab dieser Stelle (ohne gespeicherte Aufnahme gesperrt). */
function TimeButton(props: { seconds: number; disabled: boolean; onPlay: (s: number) => void }) {
  return (
    <BasedToken label={timecode(props.seconds)} mono disabled={props.disabled} description={props.disabled ? "No recording yet" : "Play from here"}
      testID="meeting-time" data={{ "data-seconds": String(props.seconds) }} onClick={() => props.onPlay(props.seconds)} />
  );
}

function TitleField(props: { store: WorkspaceStore; id: string; title: string; editable: boolean }) {
  const [draft, setDraft] = useState<string | undefined>();
  if (!props.editable) return <span className="bx-meet-title">{props.title || "Meeting notes"}</span>;
  const commit = () => {
    if (draft !== undefined && draft !== props.title) setMeetingTitle(props.store, props.id, draft.trim());
    setDraft(undefined);
  };
  return (
    <input className="bx-meet-title" aria-label="Meeting title" placeholder="Meeting notes" value={draft ?? props.title}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") setDraft(undefined);
      }} />
  );
}

// MARK: Kontext

/**
 * Enter in einem Feld des Blocks (Kontext, Sprecher) übernimmt und schließt das Feld. Ohne preventDefault ginge der
 * Rest des Tastendrucks (beforeinput „insertParagraph“) an die Notiz, die danach den Fokus bekommt – neue leere Notiz.
 */
const noTextInput = (e: ReactKeyboardEvent) => {
  if (e.key === "Enter") e.preventDefault();
};

function ContextChip(props: { pages: PageDirectory | undefined; onOpenPage: ((id: string) => void) | undefined; pageID: string | undefined; label: string; editable: boolean; onRemove: () => void }) {
  const ref = usePageRefMaybe(props.pages, props.pageID);
  const label = props.pageID ? (ref && !ref.missing ? ref.title : props.label || "Page") : props.label;
  const short = label.length > 40 ? label.slice(0, 40) + "…" : label;
  return (
    <BasedToken label={short} testID="meeting-context-chip" description={short !== label ? label : undefined}
      {...(props.pageID && props.onOpenPage ? { onClick: () => props.onOpenPage!(props.pageID!) } : {})}
      {...(props.editable ? { onRemove: props.onRemove } : {})} />
  );
}

const NO_PAGES: PageDirectory = { get: () => undefined, subscribe: () => () => undefined, search: async () => [] };
function usePageRefMaybe(pages: PageDirectory | undefined, id: string | undefined): PageRef | undefined {
  return usePageRef(pages ?? NO_PAGES, id ?? "");
}

function ContextBar(props: { store: WorkspaceStore; pages: PageDirectory | undefined; onOpenPage: ((id: string) => void) | undefined; id: string; info: MeetingInfo; editable: boolean }) {
  const [mode, setMode] = useState<"idle" | "page" | "note">("idle");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PageRef[]>([]);
  const { pages, store } = props;
  useEffect(() => {
    if (mode !== "page" || !pages) return;
    let live = true;
    void pages.search(query).then((r) => live && setResults(r.filter((p) => p.kind !== "row").slice(0, 8)), () => undefined);
    return () => {
      live = false;
    };
  }, [mode, query, pages]);
  const items = props.info.context ?? [];
  if (!props.editable && items.length === 0) return null;
  const done = () => {
    setMode("idle");
    setQuery("");
  };
  return (
    <div className="bx-meet-context">
      {items.map((it) => (
        <ContextChip key={it.id} pages={pages} onOpenPage={props.onOpenPage} pageID={it.kind === "page" ? it.pageID : undefined} label={it.title ?? it.text ?? "Item"} editable={props.editable}
          onRemove={() => removeMeetingContext(store, props.id, it.id)} />
      ))}
      {props.editable && mode === "idle" ? (
        <BasedMenu label={items.length ? "Add" : "Add context"} variant="ghost" items={[
          ...(pages ? [{ label: "Link a page", description: "Agenda, specs: they go to the summary", onSelect: () => setMode("page") }] : []),
          { label: "Add a note", description: "Names, background, vocabulary", onSelect: () => setMode("note") },
        ]} />
      ) : null}
      {mode === "page" ? (
        <div className="bx-meet-picker bx2-meet-picker" onKeyDownCapture={noTextInput} onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") done();
        }}>
          <BasedField label="Search pages" labelHidden autoFocus placeholder="Search pages…" value={query} onChange={setQuery}
            onEnter={() => {
              const p = results[0];
              if (!p) return;
              addMeetingContext(store, props.id, { kind: "page", pageID: p.id, title: p.title });
              done();
            }} />
          <div className="bx2-meet-results" role="list">
            {results.map((p) => (
              <BasedButton key={p.id} label={p.title || "Untitled"} variant="ghost" onClick={() => {
                addMeetingContext(store, props.id, { kind: "page", pageID: p.id, title: p.title });
                done();
              }} />
            ))}
          </div>
          <BasedButton label="Cancel" variant="ghost" onClick={done} />
        </div>
      ) : null}
      {mode === "note" ? (
        <div className="bx2-meet-note-field" onKeyDownCapture={noTextInput} onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") done();
        }}>
          <BasedField label="Context note" labelHidden autoFocus placeholder="Agenda, names, background… (Enter to add)" value={query} onChange={setQuery}
            onEnter={() => {
              if (query.trim() === "") return;
              addMeetingContext(store, props.id, { kind: "text", text: query.trim() });
              done();
            }} />
          <BasedButton label="Cancel" variant="ghost" onClick={done} />
        </div>
      ) : null}
    </div>
  );
}

// MARK: Notizen

function StampedNotes(props: { store: WorkspaceStore; id: string; disabled: boolean; onPlay: (s: number) => void }) {
  const notes = stampedNotes(props.store, props.id);
  if (notes.length === 0) return null;
  return (
    <div className="bx-meet-stamped" data-testid="meeting-stamped-notes">
      <span className="bx-meet-label">In the recording</span>
      {notes.map((n) => (
        <div key={n.id} className="bx-meet-stamp-row">
          <TimeButton seconds={n.time} disabled={props.disabled} onPlay={props.onPlay} />
          <span className="bx-meet-muted bx-meet-ellipsis" title={n.text}>{n.text}</span>
        </div>
      ))}
    </div>
  );
}

// MARK: Zusammenfassung

function SummaryTab(props: {
  store: WorkspaceStore; id: string; info: MeetingInfo; summaryID: string | undefined; count: number; host: MeetingHost | undefined; summarizing: boolean;
  editable: boolean; disabled: boolean; hasContent: boolean; onPlay: (s: number) => void; renderSection: MeetingBlockProps["renderSection"];
}) {
  const { store, host } = props;
  const engine = host?.hasSummaryEngine() === true;
  const generate = (
    <BasedButton label={props.summarizing ? "Writing summary…" : props.count > 0 ? "Regenerate summary" : "Generate summary"}
      variant={props.count > 0 ? "secondary" : "primary"} busy={props.summarizing} disabled={!props.hasContent || props.summarizing}
      onClick={() => {
        crumb("meeting summarize");
        void host?.summarize(store, props.id);
      }} />
  );
  const needsContent = !props.hasContent ? <span className="bx-meet-muted">Record or write notes first.</span> : null;
  if (props.summaryID && props.count > 0) {
    const cited = [...new Set(meetingSummaryTexts(store, props.id).flatMap((t) => citations(t).map((c) => c.seconds)))].sort((a, b) => a - b).slice(0, 16);
    return (
      <>
        <div className="bx-meet-summary" data-testid="meeting-summary">
          <span className="bx-meet-agent-tag" title="Written by an AI from this meeting">Based · from your recording</span>
          {props.renderSection(props.summaryID, undefined)}
        </div>
        {cited.length ? (
          <div className="bx-meet-jump" data-testid="meeting-citations">
            <span className="bx-meet-label">Jump to</span>
            {cited.map((s) => <TimeButton key={s} seconds={s} disabled={props.disabled} onPlay={props.onPlay} />)}
          </div>
        ) : null}
        <div className="bx-meet-row">
          {props.info.summaryEngine ? <span className="bx-meet-muted">Written by {props.info.summaryEngine}</span> : null}
          {engine && props.editable ? generate : null}
        </div>
      </>
    );
  }
  if (!engine) {
    return (
      <p className="bx-meet-hint">
        Connect an AI under Settings → Agents &amp; AI to get a summary with key points, decisions and action items. Recording and notes work without it.
      </p>
    );
  }
  return props.editable ? <div className="bx-meet-row">{generate}{needsContent}</div> : <p className="bx-meet-hint">No summary yet.</p>;
}

// MARK: Transkript

function TranscriptTab(props: {
  store: WorkspaceStore; id: string; info: MeetingInfo; editable: boolean; recording: boolean; mode: MeetingHostState["transcription"]; processing: boolean; host: MeetingHost | undefined; disabled: boolean; onPlay: (s: number) => void; playingFrom: number | undefined;
}) {
  const { store, info } = props;
  const segments = meetingTranscript(store, props.id);
  if (segments.length === 0) {
    const text = !props.host?.hasTranscriber()
      ? "Transcription isn't set up on this device yet. Set it up in Settings → Meeting notes. The recording and your timestamped notes are saved with the meeting."
      : props.recording
        ? props.mode === "after" ? "Recording. The transcript is made when you stop."
          : props.mode === "deferred" ? `Recording. The transcript is made ${whenLater(props.host.pendingReason?.())}.`
            : "Listening… text appears after the first sentence."
        : props.processing ? "Transcribing the recording…" : "No transcript yet. Start transcribing to get one.";
    // Feedback 17. 11.: Aufnahme von vorher (ohne Transkription gemacht) nachträglich transkribieren.
    const host = props.host;
    const later = host?.transcribeNow && host.hasTranscriber() && props.editable && !props.recording && !props.processing && !props.disabled && (info.tracks?.length ?? 0) > 0 && !info.transcribePending;
    return (
      <>
        <p className="bx-meet-hint" data-testid="meeting-transcript-empty">{later ? "This recording has no transcript yet." : text}</p>
        {later ? (
          <div className="bx-meet-row">
            <BasedButton label="Transcribe recording" onClick={() => {
              crumb("meeting transcribe now");
              void host.transcribeNow?.(store, props.id);
            }} />
          </div>
        ) : null}
      </>
    );
  }
  return (
    <>
      <SpeakerLegend store={store} id={props.id} info={info} editable={props.editable} />
      <div className="bx-meet-transcript" data-testid="meeting-transcript">
        {transcriptParagraphs(segments).map((p) => (
          <Paragraph key={p.id} p={p} info={info} disabled={props.disabled} onPlay={props.onPlay} active={props.playingFrom !== undefined && props.playingFrom >= p.start && props.playingFrom < p.end + 0.01} />
        ))}
      </div>
    </>
  );
}

function Paragraph(props: { p: TranscriptParagraph; info: MeetingInfo; disabled: boolean; onPlay: (s: number) => void; active: boolean }) {
  const { p } = props;
  const speaker = speakerOf(props.info, p.speaker);
  const partial = p.segments.some((s) => s.p === true);
  const play = () => !props.disabled && props.onPlay(p.start);
  return (
    <div className="bx-meet-para" data-active={props.active ? "true" : undefined} data-partial={partial ? "true" : undefined}
      role={props.disabled ? undefined : "button"} tabIndex={props.disabled ? undefined : 0} onClick={play}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          play();
        }
      }}>
      <div className="bx-meet-para-head">
        <span className="bx-meet-speaker" data-color={speaker?.color && speaker.color !== "default" ? speaker.color : undefined}>{speakerName(props.info, p.speaker)}</span>
        <TimeButton seconds={p.start} disabled={props.disabled} onPlay={props.onPlay} />
      </div>
      <div className="bx-meet-para-text">{p.text}</div>
    </div>
  );
}

function SpeakerLegend(props: { store: WorkspaceStore; id: string; info: MeetingInfo; editable: boolean }) {
  const [editing, setEditing] = useState<string | undefined>();
  const [name, setName] = useState("");
  const list = props.info.speakers ?? [];
  if (list.length === 0) return null;
  const { store, editable } = props;
  const nodes: ReactNode[] = list.map((s) => {
    if (editing === s.id) {
      const others = list.filter((o) => o.id !== s.id);
      return (
        <span key={s.id} className="bx-meet-chip bx2-meet-speaker-edit" onKeyDownCapture={noTextInput} onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") setEditing(undefined);
        }}>
          <BasedField label="Speaker name" labelHidden autoFocus value={name} onChange={setName} onEnter={() => {
            if (name.trim()) renameSpeaker(store, props.id, s.id, name.trim());
            setEditing(undefined);
          }} />
          {others.length ? (
            <BasedMenu label="Same person as…" variant="ghost" items={others.map((o) => ({ label: o.name, onSelect: () => {
              mergeSpeakers(store, props.id, s.id, o.id);
              setEditing(undefined);
            } }))} />
          ) : null}
          <BasedButton label="Done" variant="ghost" onClick={() => {
            if (name.trim() && name.trim() !== s.name) renameSpeaker(store, props.id, s.id, name.trim());
            setEditing(undefined);
          }} />
        </span>
      );
    }
    return (
      <BasedToken key={s.id} label={s.name} color={tokenColor(s.color)} testID="meeting-speaker" {...(editable ? { description: "Rename or merge", onClick: () => {
        setName(s.name);
        setEditing(s.id);
      } } : {})} />
    );
  });
  return <div className="bx-meet-legend">{nodes}</div>;
}
