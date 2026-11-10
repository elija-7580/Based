// BSD-226: Der `/meet`-Block (Swift MeetingBlockView): Aufnahme → Live-Transkript → Zusammenfassung, mit Notizen,
// Sprechern und Kontext an einem Ort. Notizen und Zusammenfassung sind eigene Editoren auf ihren Abschnitten (wie
// Synced Blocks); das Transkript zeichnet der Block selbst aus den Chunk-Records. Aufnahme, Wiedergabe und KI kommen
// über `env.meeting` (MeetingHost) – ohne Host ist der Block nur lesbar.
import { createReactBlockSpec } from "@blocknote/react";
import {
  addMeetingContext, citations, findMeetingSection, meetingInfo, meetingSection, meetingSummaryTexts, meetingTranscript, mergeSpeakers,
  plainText, removeMeetingContext, renameSpeaker, setMeetingTitle, speakerName, speakerOf, stampedNotes, timecode, transcriptChunks,
  transcriptParagraphs, updateMeeting, type MeetingInfo, type TranscriptParagraph,
} from "@based/core";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { CUSTOM } from "../mapping/bn.js";
import { useEnv, usePageRef, useStoreRevision, type EditorEnv, type PageRef } from "../ui/env.js";
import type { MeetingHost, MeetingHostState } from "../ui/meetingHost.js";

type Tab = "summary" | "notes" | "transcript";
const TABS: { id: Tab; label: string }[] = [{ id: "summary", label: "Summary" }, { id: "notes", label: "Notes" }, { id: "transcript", label: "Transcript" }];

const IDLE: MeetingHostState = {
  meetingID: undefined, recording: false, paused: false, elapsed: 0, roles: [], processing: [], summarizing: [], error: undefined, warning: undefined, playback: undefined,
};
const noSubscribe = () => () => undefined;
const idle = () => IDLE;

function useHost(host: MeetingHost | undefined): MeetingHostState {
  return useSyncExternalStore(host ? host.subscribe : noSubscribe, host ? host.getState : idle);
}

/**
 * Klicks in den Block (Knöpfe, Felder) sollen ihn nicht als Knoten im Seiten-Editor auswählen (blauer Rahmen). Nativ,
 * weil ProseMirror selbst nativ auf mousedown hört; die eingebetteten Editoren liegen darunter und bekommen es vorher.
 */
const stopMouseDown = (el: HTMLDivElement | null) => {
  if (!el || el.dataset.stopMouse) return;
  el.dataset.stopMouse = "1";
  el.addEventListener("mousedown", (e) => e.stopPropagation());
};

function TimeButton(props: { seconds: number; disabled: boolean; onPlay: (s: number) => void; label?: string }) {
  return (
    <button type="button" className="bx-meet-time" disabled={props.disabled} title={props.disabled ? "No recording yet" : "Play from here"}
      aria-label={`Play from ${timecode(props.seconds)}`} data-seconds={props.seconds}
      onClick={(e) => {
        e.stopPropagation();
        props.onPlay(props.seconds);
      }}>
      {props.label ?? timecode(props.seconds)}
    </button>
  );
}

function MeetingView(props: { id: string }) {
  const env = useEnv();
  const { store } = env;
  useStoreRevision(store);
  const host = env.meeting;
  const hs = useHost(host);
  const [tab, setTab] = useState<Tab | undefined>();
  const [systemAudio, setSystemAudio] = useState(false);
  const block = store.blocks.get(props.id);
  const info: MeetingInfo = meetingInfo(store, props.id) ?? { status: "ready" };
  const editable = env.editable;
  const notesID = findMeetingSection(store, props.id, "notes");
  const summaryID = findMeetingSection(store, props.id, "summary");

  // Meetings ohne Abschnitte (neu aus dem Slash-Menü per Kopieren, ältere Versionen): Abschnitte anlegen.
  useEffect(() => {
    if (!editable || store.blocks.get(props.id)?.type !== "meeting") return;
    if (!store.blocks.get(props.id)?.props?.meeting) updateMeeting(store, props.id, () => undefined, { name: "Meeting", undoable: false });
    if (!findMeetingSection(store, props.id, "notes")) meetingSection(store, props.id, "notes");
    if (!findMeetingSection(store, props.id, "summary")) meetingSection(store, props.id, "summary");
  }, [editable, store, props.id]);

  if (!block) return null;
  const recordingHere = hs.recording && hs.meetingID === props.id;
  const busyElsewhere = hs.recording && hs.meetingID !== props.id;
  const processing = hs.processing.includes(props.id);
  const summarizing = hs.summarizing.includes(props.id);
  const segments = meetingTranscript(store, props.id);
  const hasTracks = (info.tracks?.length ?? 0) > 0;
  const summaryBlocks = summaryID ? store.children("b:" + summaryID).length : 0;
  const current: Tab = tab ?? (recordingHere ? "notes" : summaryBlocks > 0 ? "summary" : transcriptChunks(store, props.id).length > 0 ? "transcript" : "notes");
  const play = (s: number) => host?.play(store, props.id, s);
  const playback = hs.playback?.meetingID === props.id ? hs.playback : undefined;
  const error = info.error ?? host?.errorFor(props.id) ?? (recordingHere ? hs.error : undefined);
  const speakers = new Set(meetingTranscript(store, props.id, false).map((s) => s.sp).filter((s) => s !== undefined)).size;
  const meta = [
    info.startedAt !== undefined ? new Date(978_307_200_000 + info.startedAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : undefined,
    info.duration ? timecode(info.duration) : undefined,
    speakers > 0 ? `${speakers} speaker${speakers === 1 ? "" : "s"}` : undefined,
  ].filter((x) => x !== undefined);

  return (
    <div className="bx-meet" ref={stopMouseDown} contentEditable={false} data-testid="meeting-block" data-status={info.status} data-recording={recordingHere ? "true" : undefined}>
      <div className="bx-meet-head">
        <span className="bx-meet-icon" data-live={recordingHere && !hs.paused ? "true" : undefined} aria-hidden>●</span>
        <TitleField id={props.id} title={plainText(block.text)} editable={editable} />
      </div>

      <div className="bx-meet-controls">
        {recordingHere ? (
          <>
            <button type="button" className="bx-meet-btn" onClick={() => (hs.paused ? host?.resume() : host?.pause())}>{hs.paused ? "Resume" : "Pause"}</button>
            <button type="button" className="bx-meet-btn is-primary" onClick={() => void host?.stop()}>Stop</button>
            <span className="bx-meet-clock" aria-label="Recording time" data-testid="meeting-clock">{timecode(hs.elapsed)}</span>
            <span className="bx-meet-muted">{hs.paused ? "Paused" : hs.roles.includes("system") ? "Microphone + shared audio" : "Microphone"}</span>
          </>
        ) : (
          <>
            {host && editable && host.canRecord() ? (
              <button type="button" className="bx-meet-btn is-primary" disabled={busyElsewhere || processing}
                title={busyElsewhere ? "Another meeting is recording" : "Records your microphone"}
                onClick={() => {
                  setTab("notes");
                  void host.start(store, props.id, { systemAudio });
                }}>
                {hasTracks ? "Continue recording" : host.hasTranscriber() ? "Start transcribing" : "Start recording"}
              </button>
            ) : null}
            {host && editable && host.canRecord() && host.canCaptureSystemAudio() ? (
              <label className="bx-meet-check" title="Your browser asks which tab or screen to share; tick “Share audio” there.">
                <input type="checkbox" checked={systemAudio} onChange={(e) => setSystemAudio(e.target.checked)} /> Include tab or system audio
              </label>
            ) : null}
            {!host || !host.canRecord() ? <span className="bx-meet-muted">{host ? "Recording isn't available in this browser." : "Recording works in the Based app."}</span> : null}
            {playback ? (
              <span className="bx-meet-playing" data-testid="meeting-playback" data-from={playback.from}>
                {playback.error ? playback.error : `${playback.playing ? "Playing" : "Paused"} · ${timecode(playback.position)}`}
                <button type="button" className="bx-meet-link" onClick={() => host?.stopPlayback()}>Stop</button>
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
        {processing ? <span>Saving and transcribing…</span> : null}
        {summarizing ? <span>Writing summary…</span> : null}
        {error ? <span className="bx-meet-error" role="alert">{error}</span> : null}
      </div>

      <ContextBar env={env} id={props.id} info={info} editable={editable} />

      <div className="bx-meet-tabs" role="tablist" aria-label="Meeting">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={current === t.id} className="bx-meet-tab" onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      <div className="bx-meet-body" role="tabpanel" aria-label={TABS.find((t) => t.id === current)!.label}>
        {current === "notes" ? (
          <>
            {notesID ? <div className="bx-meet-doc">{env.renderSynced(notesID)}</div> : <span className="bx-meet-muted">No notes.</span>}
            {recordingHere ? <p className="bx-meet-hint">Type notes — each one is linked to the moment in the recording.</p> : null}
            <StampedNotes env={env} id={props.id} disabled={!hasTracks || !host} onPlay={play} />
          </>
        ) : current === "summary" ? (
          <SummaryTab env={env} id={props.id} info={info} summaryID={summaryID} count={summaryBlocks} host={host} summarizing={summarizing}
            disabled={!hasTracks || !host} onPlay={play} hasContent={segments.length > 0 || store.descendants(notesID ?? "").some((d) => plainText(store.blocks.get(d)?.text).trim() !== "")} />
        ) : (
          <TranscriptTab env={env} id={props.id} info={info} recording={recordingHere} host={host} disabled={!hasTracks || !host} onPlay={play} playingFrom={playback?.from} />
        )}
      </div>
    </div>
  );
}

function TitleField(props: { id: string; title: string; editable: boolean }) {
  const env = useEnv();
  const [draft, setDraft] = useState<string | undefined>();
  if (!props.editable) return <span className="bx-meet-title">{props.title || "Meeting notes"}</span>;
  const commit = () => {
    if (draft !== undefined && draft !== props.title) setMeetingTitle(env.store, props.id, draft.trim());
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

function ContextChip(props: { env: EditorEnv; pageID: string | undefined; label: string; editable: boolean; onRemove: () => void }) {
  const ref = usePageRef(props.env.pages, props.pageID ?? "");
  const label = props.pageID ? (ref && !ref.missing ? ref.title : props.label || "Page") : props.label;
  return (
    <span className="bx-meet-chip">
      {props.pageID ? (
        <button type="button" className="bx-meet-link" onClick={() => {
          props.env.flush();
          props.env.onOpenPage?.(props.pageID!);
        }}>{label}</button>
      ) : <span title={props.label}>{label.length > 40 ? label.slice(0, 40) + "…" : label}</span>}
      {props.editable ? <button type="button" className="bx-meet-x" aria-label={`Remove ${label}`} onClick={props.onRemove}>×</button> : null}
    </span>
  );
}

function ContextBar(props: { env: EditorEnv; id: string; info: MeetingInfo; editable: boolean }) {
  const [mode, setMode] = useState<"idle" | "menu" | "page" | "note">("idle");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PageRef[]>([]);
  const { env } = props;
  useEffect(() => {
    if (mode !== "page") return;
    let live = true;
    void env.pages.search(query).then((r) => live && setResults(r.filter((p) => p.kind !== "row").slice(0, 8)));
    return () => {
      live = false;
    };
  }, [mode, query, env.pages]);
  const items = props.info.context ?? [];
  if (!props.editable && items.length === 0) return null;
  return (
    <div className="bx-meet-context">
      {items.map((it) => (
        <ContextChip key={it.id} env={env} pageID={it.kind === "page" ? it.pageID : undefined} label={it.title ?? it.text ?? "Item"} editable={props.editable}
          onRemove={() => removeMeetingContext(env.store, props.id, it.id)} />
      ))}
      {props.editable && mode === "idle" ? (
        <button type="button" className="bx-meet-link" title="Agenda, specs, people: they go to the summary" onClick={() => setMode("menu")}>
          {items.length ? "+ Add" : "+ Add context"}
        </button>
      ) : null}
      {mode === "menu" ? (
        <span className="bx-meet-chip">
          <button type="button" className="bx-meet-link" onClick={() => setMode("page")}>Link a page</button>
          <button type="button" className="bx-meet-link" onClick={() => setMode("note")}>Add a note</button>
          <button type="button" className="bx-meet-x" aria-label="Cancel" onClick={() => setMode("idle")}>×</button>
        </span>
      ) : null}
      {mode === "page" ? (
        <div className="bx-meet-picker">
          <input className="bx-field" autoFocus placeholder="Search pages…" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setMode("idle");
            }} />
          <ul className="bx-picker-list">
            {results.map((p) => (
              <li key={p.id}><button type="button" onClick={() => {
                addMeetingContext(env.store, props.id, { kind: "page", pageID: p.id, title: p.title });
                setMode("idle");
                setQuery("");
              }}>{p.title}</button></li>
            ))}
          </ul>
        </div>
      ) : null}
      {mode === "note" ? (
        <input className="bx-field bx-meet-note-field" autoFocus placeholder="Agenda, names, background… (Enter to add)" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onBlur={() => setMode("idle")}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") setMode("idle");
            if (e.key === "Enter" && query.trim() !== "") {
              addMeetingContext(env.store, props.id, { kind: "text", text: query.trim() });
              setQuery("");
              setMode("idle");
            }
          }} />
      ) : null}
    </div>
  );
}

// MARK: Notizen

function StampedNotes(props: { env: EditorEnv; id: string; disabled: boolean; onPlay: (s: number) => void }) {
  const notes = stampedNotes(props.env.store, props.id);
  if (notes.length === 0) return null;
  return (
    <div className="bx-meet-stamped" data-testid="meeting-stamped-notes">
      <span className="bx-meet-label">In the recording</span>
      {notes.map((n) => (
        <div key={n.id} className="bx-meet-stamp-row">
          <TimeButton seconds={n.time} disabled={props.disabled} onPlay={props.onPlay} />
          <span className="bx-meet-muted bx-meet-ellipsis">{n.text}</span>
        </div>
      ))}
    </div>
  );
}

// MARK: Zusammenfassung

function SummaryTab(props: {
  env: EditorEnv; id: string; info: MeetingInfo; summaryID: string | undefined; count: number; host: MeetingHost | undefined; summarizing: boolean;
  disabled: boolean; hasContent: boolean; onPlay: (s: number) => void;
}) {
  const { env, host } = props;
  const engine = host?.hasSummaryEngine() === true;
  const generate = (
    <button type="button" className="bx-meet-btn" disabled={!props.hasContent || props.summarizing}
      title={props.hasContent ? undefined : "Record or write notes first"}
      onClick={() => void host?.summarize(env.store, props.id)}>
      {props.summarizing ? "Writing summary…" : props.count > 0 ? "Regenerate summary" : "Generate summary"}
    </button>
  );
  if (props.summaryID && props.count > 0) {
    const cited = [...new Set(meetingSummaryTexts(env.store, props.id).flatMap((t) => citations(t).map((c) => c.seconds)))].sort((a, b) => a - b).slice(0, 16);
    return (
      <>
        <div className="bx-meet-summary" data-testid="meeting-summary">
          <span className="bx-meet-agent-tag" title="Written by an AI from this meeting">Based · from your recording</span>
          <div className="bx-meet-doc">{env.renderSynced(props.summaryID)}</div>
        </div>
        {cited.length ? (
          <div className="bx-meet-jump" data-testid="meeting-citations">
            <span className="bx-meet-label">Jump to</span>
            {cited.map((s) => <TimeButton key={s} seconds={s} disabled={props.disabled} onPlay={props.onPlay} />)}
          </div>
        ) : null}
        <div className="bx-meet-row">
          {props.info.summaryEngine ? <span className="bx-meet-muted">Written by {props.info.summaryEngine}</span> : null}
          {engine && env.editable ? generate : null}
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
  return env.editable ? <div className="bx-meet-row">{generate}</div> : <p className="bx-meet-hint">No summary yet.</p>;
}

// MARK: Transkript

function TranscriptTab(props: {
  env: EditorEnv; id: string; info: MeetingInfo; recording: boolean; host: MeetingHost | undefined; disabled: boolean; onPlay: (s: number) => void; playingFrom: number | undefined;
}) {
  const { env, info } = props;
  const segments = meetingTranscript(env.store, props.id);
  if (segments.length === 0) {
    const text = !props.host?.hasTranscriber()
      ? "Transcription isn't available in this app yet. The recording and your timestamped notes are saved with the meeting."
      : props.recording ? "Listening… text appears after the first sentence." : "No transcript yet. Start transcribing to get one.";
    return <p className="bx-meet-hint" data-testid="meeting-transcript-empty">{text}</p>;
  }
  return (
    <>
      <SpeakerLegend env={env} id={props.id} info={info} />
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
        e.stopPropagation();
        if (e.key === "Enter") play();
      }}>
      <div className="bx-meet-para-head">
        <span className="bx-meet-speaker" data-color={speaker?.color && speaker.color !== "default" ? speaker.color : undefined}>{speakerName(props.info, p.speaker)}</span>
        <TimeButton seconds={p.start} disabled={props.disabled} onPlay={props.onPlay} />
      </div>
      <div className="bx-meet-para-text">{p.text}</div>
    </div>
  );
}

function SpeakerLegend(props: { env: EditorEnv; id: string; info: MeetingInfo }) {
  const [editing, setEditing] = useState<string | undefined>();
  const [name, setName] = useState("");
  const list = props.info.speakers ?? [];
  if (list.length === 0) return null;
  const { store, editable } = props.env;
  const nodes: ReactNode[] = list.map((s) => {
    if (editing === s.id) {
      const others = list.filter((o) => o.id !== s.id);
      return (
        <span key={s.id} className="bx-meet-chip">
          <input className="bx-field bx-meet-name" autoFocus aria-label="Speaker name" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                renameSpeaker(store, props.id, s.id, name);
                setEditing(undefined);
              }
              if (e.key === "Escape") setEditing(undefined);
            }} />
          {others.length ? (
            <select className="bx-meet-select" aria-label="Same person as" value="" onChange={(e) => {
              if (e.target.value) mergeSpeakers(store, props.id, s.id, e.target.value);
              setEditing(undefined);
            }}>
              <option value="">Same person as…</option>
              {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          ) : null}
          <button type="button" className="bx-meet-x" aria-label="Done" onClick={() => setEditing(undefined)}>×</button>
        </span>
      );
    }
    return (
      <button key={s.id} type="button" className="bx-meet-chip bx-meet-speaker" data-color={s.color && s.color !== "default" ? s.color : undefined}
        disabled={!editable} title={editable ? "Rename or merge" : undefined}
        onClick={() => {
          setName(s.name);
          setEditing(s.id);
        }}>{s.name}</button>
    );
  });
  return <div className="bx-meet-legend">{nodes}</div>;
}

export const meetingBlock = createReactBlockSpec(
  { type: CUSTOM.meeting, propSchema: {}, content: "none" },
  { render: ({ block }) => <MeetingView id={block.id} /> },
);
