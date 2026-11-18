// Feedback 18. 11.: Meeting-Erkennung – welche App zählt, wann das Fenster kommt und geht.
import { describe, expect, it } from "vitest";
import { ANY_APP, DETECT_IDLE, detectDismiss, detectStep, meetingApp, promptText, type DetectState } from "./detect.js";

describe("meetingApp", () => {
  it("erkennt Meeting-Apps und Browser an der Bundle-ID (auch Helfer-Prozesse)", () => {
    expect(meetingApp(["us.zoom.xos"])).toBe("Zoom");
    expect(meetingApp(["com.microsoft.teams2"])).toBe("Microsoft Teams");
    expect(meetingApp(["com.google.Chrome.helper"])).toBe("Chrome");
    expect(meetingApp(["com.tinyspeck.slackmacgap.helper"])).toBe("Slack");
    expect(meetingApp(["com.apple.WebKit.GPU"])).toBe("Safari");
  });
  it("Diktat, Siri, Sprachmemos und Unbekanntes lösen nichts aus", () => {
    expect(meetingApp([])).toBeUndefined();
    expect(meetingApp(["com.apple.corespeechd", "com.apple.VoiceMemos", "com.example.tool"])).toBeUndefined();
  });
  it("ältere macOS ohne App-Angabe: „Mikrofon läuft“", () => {
    expect(meetingApp([ANY_APP])).toBe(ANY_APP);
    expect(promptText(ANY_APP).detail).toContain("Your microphone is in use");
    expect(promptText("Zoom").detail).toBe("Zoom is using your microphone. Transcribe it into Based?");
  });
});

describe("detectStep", () => {
  const on = (s: DetectState, app: string | undefined, recording = false, enabled = true) => detectStep(s, { app, recording, enabled });

  it("fragt erst, wenn die App zweimal hintereinander aufnimmt, und nur einmal", () => {
    let r = on(DETECT_IDLE, "Zoom");
    expect(r.action).toBeUndefined();
    r = on(r.state, "Zoom");
    expect(r.action).toEqual({ kind: "show", app: "Zoom" });
    r = on(r.state, "Zoom");
    expect(r.action).toBeUndefined();
    // Mikrofon aus → Fenster weg
    r = on(r.state, undefined);
    expect(r.action).toEqual({ kind: "hide" });
  });

  it("ein kurzer Mikrofon-Test (ein Nachsehen) fragt nicht", () => {
    let r = on(DETECT_IDLE, "Slack");
    r = on(r.state, undefined);
    r = on(r.state, "Slack");
    expect(r.action).toBeUndefined();
  });

  it("„Not now“ gilt, bis die App das Mikrofon freigibt", () => {
    let r = on(on(DETECT_IDLE, "Zoom").state, "Zoom");
    r = detectDismiss(r.state);
    expect(r.action).toEqual({ kind: "hide" });
    for (let i = 0; i < 3; i++) {
      r = on(r.state, "Zoom");
      expect(r.action).toBeUndefined();
    }
    r = on(r.state, undefined);
    r = on(on(r.state, "Zoom").state, "Zoom");
    expect(r.action).toEqual({ kind: "show", app: "Zoom" });
  });

  it("nimmt Based selbst auf oder ist es ausgeschaltet: kein Fenster (ein offenes geht zu)", () => {
    let r = on(on(DETECT_IDLE, "Zoom").state, "Zoom");
    expect(r.action?.kind).toBe("show");
    r = on(r.state, "Zoom", true);
    expect(r.action).toEqual({ kind: "hide" });
    r = on(r.state, "Zoom", true);
    expect(r.action).toBeUndefined();
    r = on(on(DETECT_IDLE, "Zoom", false, false).state, "Zoom", false, false);
    expect(r.action).toBeUndefined();
  });
});
