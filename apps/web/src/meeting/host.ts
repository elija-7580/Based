// BSD-226: MeetingHost der Web-App – MeetingRecorder (@based/brain) mit Browser-Aufnahme, Asset-Speicher (BSD-78),
// Wiedergabe und der Engine aus Einstellungen → Agents & AI. Eine Transkription gibt es hier (noch) nicht: die
// Swift-App transkribiert auf dem Gerät (Parakeet); ein Anbieter-Format für Audio gibt es in der Vorlage nicht.
// Tests/E2E setzen über `globalThis.__basedMeeting` einen festen Transcriber und eine ScriptedEngine ein.
import {
  FixedTranscriber, MEETING_SUMMARY_SYSTEM, MeetingRecorder, ModelEngine, ScriptedEngine,
  type CapturedTrack, type ChatEngine, type FixedLine, type ScriptStep, type Transcriber,
} from "@based/brain";
import { meetingInfo, type WorkspaceStore } from "@based/core";
import type { MeetingHost, MeetingHostState } from "@based/editor";
import { aiConfig } from "../chat/aiConfig.js";
import type { PageReplica, StoreClient } from "../worker/client.js";
import { canCaptureSystemAudio, canRecordAudio, startBrowserCapture } from "./capture.js";
import { MeetingPlayer } from "./player.js";

export interface MeetingTestHooks {
  /** Fester Transcriber (Zeilen mit Zeiten in Sekunden ab Aufnahmebeginn); `undefined` = keiner. */
  useTranscriber(lines: FixedLine[] | undefined): void;
  /** Zusammenfassung nach Skript statt über das eingerichtete Modell. */
  useSummaryScript(steps: ScriptStep[] | undefined): void;
}

export function createMeetingHost(client: StoreClient): MeetingHost {
  let transcriber: Transcriber | undefined;
  let script: ScriptStep[] | undefined;
  const urls = new Map<string, string>();
  const listeners = new Set<() => void>();
  let cached: MeetingHostState | undefined;
  const notify = () => {
    cached = undefined;
    for (const fn of listeners) fn();
  };
  const config = aiConfig();
  if (!config.getState().loaded) void config.load();
  config.subscribe(notify);

  const recorder = new MeetingRecorder({
    capture: startBrowserCapture,
    async saveAudio(t: CapturedTrack) {
      const blob = t.data as Blob;
      const bytes = await blob.arrayBuffer();
      const info = await client.assetPut(t.name, bytes, t.mime);
      if (!urls.has(info.id)) urls.set(info.id, URL.createObjectURL(blob));
      return { id: info.id, name: t.name, size: bytes.byteLength, mime: t.mime };
    },
    async loadAudio(asset) {
      const r = await client.assetGet(asset.id);
      if (!r.ok) throw new Error(r.message);
      return new Blob([r.bytes], { type: asset.mime ?? "audio/webm" });
    },
    transcriber: () => transcriber,
    async engine(): Promise<ChatEngine | undefined> {
      if (script) return new ScriptedEngine({ script, label: "Scripted" });
      const choice = config.activeModel();
      if (!choice) return undefined;
      const provider = await config.provider(choice);
      return new ModelEngine({ provider, model: choice.model, system: MEETING_SUMMARY_SYSTEM, maxSteps: 2 });
    },
  });
  recorder.subscribe(notify);

  const player = new MeetingPlayer({
    async url(id) {
      const known = urls.get(id);
      if (known) return known;
      const r = await client.assetGet(id);
      if (!r.ok) throw new Error(r.message);
      const u = URL.createObjectURL(new Blob([r.bytes]));
      urls.set(id, u);
      return u;
    },
  }, notify);

  // Die Aufnahme läuft weiter, wenn die Seite geschlossen wird: solange hält der Dienst die Seiten-Replik offen.
  let held: PageReplica | undefined;
  const hold = async (store: WorkspaceStore, meetingID: string): Promise<WorkspaceStore> => {
    const page = store.containingPage(meetingID);
    if (!page) return store;
    try {
      const r = await client.openPage(page);
      held = r;
      return r.store === store ? store : r.store;
    } catch {
      return store;
    }
  };
  const release = () => {
    held?.close();
    held = undefined;
  };

  const hooks: MeetingTestHooks = {
    useTranscriber(lines) {
      transcriber = lines ? new FixedTranscriber(lines) : undefined;
      notify();
    },
    useSummaryScript(steps) {
      script = steps;
      notify();
    },
  };
  (globalThis as { __basedMeeting?: MeetingTestHooks }).__basedMeeting = hooks;

  return {
    getState() {
      if (!cached) {
        const r = recorder.getState();
        cached = { ...r, playback: player.playback };
      }
      return cached;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    canRecord: canRecordAudio,
    canCaptureSystemAudio,
    hasTranscriber: () => transcriber !== undefined,
    hasSummaryEngine: () => script !== undefined || config.activeModel() !== undefined,
    errorFor: (id) => recorder.errorFor(id),
    async start(store, meetingID, opts) {
      if (recorder.getState().recording) return;
      player.stop();
      const target = await hold(store, meetingID);
      await recorder.start(target, meetingID, opts);
      if (!recorder.getState().recording) release();
    },
    pause: () => recorder.pause(),
    resume: () => recorder.resume(),
    async stop() {
      try {
        await recorder.stop();
      } finally {
        release();
      }
    },
    summarize: (store, meetingID) => recorder.summarize(store, meetingID),
    play(store, meetingID, seconds) {
      void player.play(meetingID, meetingInfo(store, meetingID)?.tracks ?? [], seconds);
    },
    stopPlayback: () => player.stop(),
  };
}
