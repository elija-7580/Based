// BSD-226: MeetingHost der Web-App – MeetingRecorder (@based/brain) mit Browser-Aufnahme, Asset-Speicher (BSD-78),
// Wiedergabe und der Engine aus Einstellungen → Agents & AI. Eine Transkription gibt es hier (noch) nicht: die
// Swift-App transkribiert auf dem Gerät (Parakeet); ein Anbieter-Format für Audio gibt es in der Vorlage nicht.
// Tests/E2E setzen über `globalThis.__basedMeeting` einen festen Transcriber und eine ScriptedEngine ein.
import {
  FixedTranscriber, MEETING_SUMMARY_SYSTEM, MeetingRecorder, ScriptedEngine,
  type CapturedTrack, type ChatEngine, type FixedLine, type ScriptStep, type Transcriber,
} from "@based/brain";
import { meetingInfo, type WorkspaceStore } from "@based/core";
import type { MeetingHost, MeetingHostState } from "@based/editor";
import { aiConfig } from "../chat/aiConfig.js";
import type { PageReplica, StoreClient } from "../worker/client.js";
import { canCaptureSystemAudio, canRecordAudio, startBrowserCapture } from "./capture.js";
import { MeetingPlayer } from "./player.js";
import { onBattery, watchPower } from "./power.js";
import { meetingTranscribePref, pendingTranscripts } from "../shell/storage.js";

export interface MeetingTestHooks {
  /** Fester Transcriber (Zeilen mit Zeiten in Sekunden ab Aufnahmebeginn); `undefined` = keiner. */
  useTranscriber(lines: FixedLine[] | undefined): void;
  /** Zusammenfassung nach Skript statt über das eingerichtete Modell. */
  useSummaryScript(steps: ScriptStep[] | undefined): void;
  /** Akku-Zustand vortäuschen (`undefined` = echter Zustand) und die Warteschlange prüfen. */
  usePower(battery: boolean | undefined): Promise<void>;
}

/** BSD-281: dazu die Seite der laufenden Aufnahme (Pille oben in der Seitenleiste). */
export interface WebMeetingHost extends MeetingHost {
  recordingPage(): string | undefined;
}

export function createMeetingHost(client: StoreClient): WebMeetingHost {
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
    // Feedback 14. 11.: auf Akku nur aufnehmen, am Strom transkribieren (Einstellung „When plugged in“).
    deferTranscription: async () => meetingTranscribePref.get() === "plugged-in" && (await battery()) === true,
    async engine(): Promise<ChatEngine | undefined> {
      if (script) return new ScriptedEngine({ script, label: "Scripted" });
      const choice = config.activeModel();
      if (!choice) return undefined;
      return config.engine(choice, { system: MEETING_SUMMARY_SYSTEM, maxSteps: 2, policy: { mode: "plan" } });
    },
  });
  recorder.subscribe(notify);

  // Warteschlange der Transkripte für später: nach dem Stop eintragen, am Strom (oder beim nächsten Start) nachholen.
  let fakeBattery: boolean | undefined;
  const battery = async () => (fakeBattery !== undefined ? fakeBattery : onBattery());
  const queue = (page: string | undefined, meeting: string, on: boolean) => {
    const rest = pendingTranscripts.get().filter((p) => p.meeting !== meeting);
    pendingTranscripts.set(on && page ? [...rest, { page, meeting }] : rest);
    syncWatch();
  };
  let lastStore: WorkspaceStore | undefined;
  let draining = false;
  const drain = async (force = false) => {
    if (draining || recorder.getState().recording) return;
    const list = pendingTranscripts.get();
    if (!list.length || !transcriber) return;
    if (!force && meetingTranscribePref.get() === "plugged-in" && (await battery()) !== false) return;
    draining = true;
    try {
      for (const p of list) {
        let r: PageReplica | undefined;
        try {
          r = await client.openPage(p.page);
          const info = meetingInfo(r.store, p.meeting);
          if (info?.transcribePending) await recorder.finalize(r.store, p.meeting, { force: true });
          if (!meetingInfo(r.store, p.meeting)?.transcribePending) queue(undefined, p.meeting, false);
        } catch {
          queue(undefined, p.meeting, false);
        } finally {
          r?.close();
        }
      }
    } finally {
      draining = false;
    }
  };
  let unwatch: (() => void) | undefined;
  function syncWatch() {
    const want = pendingTranscripts.get().length > 0;
    if (want && !unwatch) unwatch = watchPower(() => void drain());
    if (!want && unwatch) { unwatch(); unwatch = undefined; }
  }
  syncWatch();
  setTimeout(() => void drain(), 10_000);
  const remember = (store: WorkspaceStore, meetingID: string) => {
    if (meetingInfo(store, meetingID)?.transcribePending) queue(store.containingPage(meetingID), meetingID, true);
  };

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
  let heldPage: string | undefined;
  const hold = async (store: WorkspaceStore, meetingID: string): Promise<WorkspaceStore> => {
    const page = store.containingPage(meetingID);
    heldPage = page;
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
    heldPage = undefined;
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
    async usePower(b) {
      fakeBattery = b;
      await drain();
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
    recordingPage: () => (recorder.getState().recording ? heldPage : undefined),
    canRecord: canRecordAudio,
    canCaptureSystemAudio,
    hasTranscriber: () => transcriber !== undefined,
    hasSummaryEngine: () => script !== undefined || config.activeModel() !== undefined,
    errorFor: (id) => recorder.errorFor(id),
    async start(store, meetingID, opts) {
      if (recorder.getState().recording) return;
      player.stop();
      const target = await hold(store, meetingID);
      lastStore = target;
      await recorder.start(target, meetingID, opts);
      if (!recorder.getState().recording) release();
    },
    pause: () => recorder.pause(),
    resume: () => recorder.resume(),
    async stop() {
      const id = recorder.getState().meetingID;
      const store = held?.store ?? lastStore;
      try {
        await recorder.stop();
      } finally {
        if (id && store) remember(store, id);
        release();
      }
    },
    async transcribeNow(store, meetingID) {
      await recorder.finalize(store, meetingID, { force: true });
      if (!meetingInfo(store, meetingID)?.transcribePending) queue(undefined, meetingID, false);
    },
    pendingReason: () => (meetingTranscribePref.get() === "plugged-in" ? "when this device is plugged in" : "comes later"),
    summarize: (store, meetingID) => recorder.summarize(store, meetingID),
    play(store, meetingID, seconds) {
      void player.play(meetingID, meetingInfo(store, meetingID)?.tracks ?? [], seconds);
    },
    stopPlayback: () => player.stop(),
  };
}
