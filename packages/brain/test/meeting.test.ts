// BSD-226: Aufnahmedienst der Meeting-Notizen mit Fake-Aufnahme, festem Transkript und ScriptedEngine.
import { describe, expect, it } from "vitest";
import {
  createMeeting, findMeetingSection, meetingInfo, meetingSummaryTexts, meetingTranscript, MemoryPersistence, citations, WorkspaceStore,
  type AudioTrackRole,
} from "@based/core";
import {
  buildMeetingSummaryPrompt, FixedTranscriber, MeetingRecorder, ScriptedEngine, stripFence, type AudioCapture, type AudioChunk, type CaptureOptions,
  type CapturedTrack, type SavedAudio,
} from "../src/index.js";

class FakeCapture implements AudioCapture {
  t = 0;
  paused = false;
  constructor(readonly roles: AudioTrackRole[], private readonly opts: CaptureOptions, readonly warning?: string) {}
  advance(seconds: number) {
    const start = this.t;
    if (!this.paused) this.t += seconds;
    for (const role of this.roles) {
      const c: AudioChunk = { role, start, end: this.t, data: "bytes" };
      this.opts.onChunk(c);
    }
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  elapsed() { return this.t; }
  stop(): Promise<CapturedTrack[]> {
    return Promise.resolve(this.roles.map((role) => ({ role, data: "audio-" + role, mime: "audio/webm", duration: this.t, name: role + ".webm" })));
  }
}

const LINES = [
  { start: 0.5, end: 2, text: "Welcome everyone.", speaker: "me" },
  { start: 3, end: 5, text: "The release ships on Friday.", speaker: "others" },
];

function setup(opts: { transcriber?: boolean; engine?: ScriptedEngine; roles?: AudioTrackRole[] } = {}) {
  let now = 1000;
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t", now: () => now });
  const m = createMeeting(store, { parent: "w", title: "Weekly" });
  let capture: FakeCapture | undefined;
  const saved: SavedAudio[] = [];
  const transcriber = new FixedTranscriber(LINES);
  const rec = new MeetingRecorder({
    capture: async (o) => (capture = new FakeCapture(opts.roles ?? ["microphone"], o)),
    saveAudio: async (t) => {
      const ref = { id: "asset-" + t.role, name: t.name, mime: t.mime };
      saved.push(ref);
      return ref;
    },
    loadAudio: async (a) => "loaded:" + a.id,
    transcriber: () => (opts.transcriber === false ? undefined : transcriber),
    engine: () => opts.engine,
    tickMs: 0,
  });
  return { store, m, rec, saved, cap: () => capture!, tick: (d: number) => (now += d) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("MeetingRecorder", () => {
  it("Start → Live-Transkript → Notiz mit Zeit → Stop → Spur gespeichert, finaler Durchlauf", async () => {
    const { store, m, rec, saved, cap, tick } = setup();
    await rec.start(store, m);
    expect(meetingInfo(store, m)?.status).toBe("recording");
    expect(meetingInfo(store, m)?.startedAt).toBe(1000);
    cap().advance(1);
    await flush();
    expect(meetingTranscript(store, m).map((s) => s.t)).toEqual(["Welcome everyone."]);
    cap().advance(3.2);
    tick(4);
    // Notiz schreiben (wie der Editor im Notiz-Abschnitt)
    const notes = findMeetingSection(store, m, "notes")!;
    store.transact("type", (tx) => tx.put({ kind: "block", data: { id: "n1", type: "text", parent: "b:" + notes, sk: "a0", createdAt: store.now(), updatedAt: store.now(), text: "Ship Friday" } }));
    await flush();
    expect(store.blocks.get("n1")?.props?.meetingTime).toBe(4.2);
    await rec.stop();
    const info = meetingInfo(store, m)!;
    expect(info.tracks).toEqual([{ role: "microphone", asset: saved[0], offset: 0, duration: 4.2 }]);
    expect(info.status).toBe("done");
    expect(info.engine).toBe("test.fixed");
    expect(meetingTranscript(store, m).map((s) => [s.id, s.t, s.sp])).toEqual([["t-0", "Welcome everyone.", "me"], ["t-1", "The release ships on Friday.", "others"]]);
    expect(info.speakers?.map((s) => s.name)).toEqual(["Me", "Others"]);
    expect(rec.getState().recording).toBe(false);
  });

  it("Pause stempelt nicht; Mikrofon + Systemton als getrennte Spuren (Me/Others)", async () => {
    const { store, m, rec, saved, cap } = setup({ roles: ["microphone", "system"] });
    await rec.start(store, m, { systemAudio: true });
    expect(meetingInfo(store, m)?.speakers?.map((s) => s.id)).toEqual(["me", "others"]);
    rec.pause();
    expect(meetingInfo(store, m)?.status).toBe("paused");
    const notes = findMeetingSection(store, m, "notes")!;
    store.transact("type", (tx) => tx.put({ kind: "block", data: { id: "n1", type: "text", parent: "b:" + notes, sk: "a0", createdAt: 0, updatedAt: 0, text: "x" } }));
    await flush();
    expect(store.blocks.get("n1")?.props?.meetingTime).toBeUndefined();
    rec.resume();
    cap().advance(2);
    await rec.stop();
    expect(saved.map((s) => s.id)).toEqual(["asset-microphone", "asset-system"]);
    expect(meetingInfo(store, m)?.tracks?.map((t) => t.role)).toEqual(["microphone", "system"]);
  });

  it("ohne Transcriber: Aufnahme und Notizen funktionieren, kein Transkript", async () => {
    const { store, m, rec, cap } = setup({ transcriber: false });
    expect(rec.hasTranscriber()).toBe(false);
    await rec.start(store, m);
    cap().advance(2);
    await rec.stop();
    expect(meetingTranscript(store, m)).toEqual([]);
    expect(meetingInfo(store, m)?.status).toBe("done");
    expect(meetingInfo(store, m)?.tracks).toHaveLength(1);
  });

  it("Aufnahme verweigert: Fehler am Meeting, kein Status-Wechsel", async () => {
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
    const m = createMeeting(store, { parent: "w" });
    const err = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    const rec = new MeetingRecorder({ capture: () => Promise.reject(err), saveAudio: () => Promise.reject(new Error("x")), tickMs: 0 });
    await rec.start(store, m);
    expect(rec.getState().recording).toBe(false);
    expect(meetingInfo(store, m)?.status).toBe("ready");
    expect(meetingInfo(store, m)?.error).toMatch(/Microphone access is blocked/);
  });

  it("Zusammenfassung über die Engine mit [m:ss]-Zitaten; Prompt enthält Transkript und Notizen", async () => {
    const engine = new ScriptedEngine({ script: [{ text: "```markdown\n## Summary\nRelease on Friday [0:03].\n\n## Action items\n- [ ] Me: Ship it [0:03]\n```" }], label: "Scripted" });
    const { store, m, rec, cap } = setup({ engine });
    await rec.start(store, m);
    cap().advance(4);
    await rec.stop();
    expect(buildMeetingSummaryPrompt(store, m)).toContain("[0:03] Others: The release ships on Friday.");
    await rec.summarize(store, m);
    expect(engine.requests[0]?.prompt).toContain("<transcript>");
    expect(engine.requests[0]?.system).toMatch(/meeting notes from a transcript/);
    const info = meetingInfo(store, m)!;
    expect(info.summary).toBe("done");
    expect(info.summaryEngine).toBe("Scripted");
    const texts = meetingSummaryTexts(store, m);
    expect(texts).toContain("Release on Friday [0:03].");
    expect(texts.flatMap((t) => citations(t).map((c) => c.seconds))).toEqual([3, 3]);
  });

  it("ohne Engine: Zusammenfassung 'unavailable'; Fehler der Engine landen am Meeting", async () => {
    const { store, m, rec } = setup();
    await rec.summarize(store, m);
    expect(meetingInfo(store, m)?.summary).toBe("unavailable");
    const failing = new ScriptedEngine({ script: [{ fail: "HTTP 401" }] });
    const s2 = setup({ engine: failing });
    await s2.rec.start(s2.store, s2.m);
    s2.cap().advance(4);
    await s2.rec.stop();
    await s2.rec.summarize(s2.store, s2.m);
    expect(meetingInfo(s2.store, s2.m)?.summary).toBe("failed");
    expect(meetingInfo(s2.store, s2.m)?.error).toBe("Summary failed: HTTP 401");
  });

  it("stripFence", () => {
    expect(stripFence("```markdown\n# A\n```")).toBe("# A");
    expect(stripFence("plain")).toBe("plain");
  });
});
