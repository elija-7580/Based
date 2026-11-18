// Feedback 18. 11.: Im Meeting-Block steht immer ausdrücklich, ob gerade transkribiert wird.
import { describe, expect, it } from "vitest";
import { liveStatus } from "../src/blocks/meeting.js";

const base = { recording: true, paused: false, processing: false, pending: false } as const;

describe("liveStatus", () => {
  it("nennt live, nach dem Stop, später und ohne Transkription getrennt", () => {
    expect(liveStatus({ ...base, transcription: "live" })).toEqual({ state: "live", label: "Transcribing" });
    expect(liveStatus({ ...base, transcription: "after" })).toEqual({ state: "recording", label: "Recording", detail: "Transcript when you stop" });
    expect(liveStatus({ ...base, transcription: "deferred", pendingReason: "when this device is plugged in" })?.detail).toBe("Transcript when this device is plugged in");
    expect(liveStatus({ ...base, transcription: "deferred", pendingReason: "comes later" })?.detail).toBe("Transcript later");
    expect(liveStatus({ ...base, transcription: "off" })?.detail).toBe("No transcription set up");
  });
  it("Pause, danach Transkribieren, wartendes Transkript; sonst nichts", () => {
    expect(liveStatus({ ...base, paused: true, transcription: "live" })?.state).toBe("paused");
    expect(liveStatus({ ...base, recording: false, processing: true, transcription: "off" })).toEqual({ state: "processing", label: "Transcribing…" });
    expect(liveStatus({ ...base, recording: false, pending: true, transcription: "off" })?.label).toBe("Not transcribed yet");
    expect(liveStatus({ ...base, recording: false, transcription: "off" })).toBeUndefined();
  });
});
