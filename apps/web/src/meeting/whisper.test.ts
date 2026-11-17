// BSD-231 Teil 3c: Transkription über den eigenen Server – nur wenn er sie anbietet; Anfrage mit Token, Sprache und
// Fachwörtern; Fehler des Servers kommen als verständliche Meldung an.
import { describe, expect, it } from "vitest";
import { downloadPercent, megabytes, modelLabel, onTranscriptionChanged, serverWhisper, transcribeModel, transcribeStatus, transcriptionChanged, transcriptionStep, whisperReady } from "./whisper.js";
import { turnOnAction, waitForLocalServer } from "./useTranscription.js";
import { meetingNotesOptionText } from "../screens/Welcome.js";
import { orderServers } from "./servers.js";
import { transcriptionHint } from "./TranscriptionSetup.js";

const cfg = { url: "http://127.0.0.1:8787/", token: "tok" };
type Call = { url: string; init?: RequestInit };

function fakeFetch(reply: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), ...(init ? { init } : {}) };
    calls.push(c);
    return reply(c);
  }) as typeof fetch;
  return { f, calls };
}

describe("Transkription einrichten (Feedback 17. 11.)", () => {
  it("lokaler Server der Mac-App zuerst, derselbe Server nur einmal", () => {
    const local = { url: "http://127.0.0.1:8791", token: "l" }, sync = { url: "https://based.example/", token: "s" };
    expect(orderServers(local, sync)).toEqual([{ ...local, local: true }, { ...sync, local: false }]);
    expect(orderServers(undefined, sync)).toEqual([{ ...sync, local: false }]);
    expect(orderServers(local, { url: "http://127.0.0.1:8791/", token: "l" })).toEqual([{ ...local, local: true }]);
    expect(orderServers(undefined, undefined)).toEqual([]);
  });

  it("Stand vom Server: keine Route → undefined; alter Server ohne engineInstalled gilt als eingerichtet", async () => {
    expect(await transcribeStatus(undefined)).toBeUndefined();
    expect(await transcribeStatus(cfg, fakeFetch(() => Response.json({ error: "not found" }, { status: 404 })).f)).toBeUndefined();
    expect(await transcribeStatus(cfg, (async () => { throw new TypeError("offline"); }) as typeof fetch)).toBeUndefined();
    expect(await transcribeStatus(cfg, fakeFetch(() => Response.json({ engine: "whisper.cpp", ready: true, model: { source: "file", installed: true } })).f))
      .toEqual({ engineInstalled: true, ready: true, model: { source: "file", installed: true } });
    const missing = await transcribeStatus(cfg, fakeFetch(() => Response.json({ engineInstalled: false, ready: false, model: { source: "catalog", installed: false, downloading: false, size: 147_951_465, name: "Whisper base" } })).f);
    expect(missing).toMatchObject({ engineInstalled: false, ready: false });
    expect(transcriptionStep(missing)).toBe("no-engine");
  });

  it("nächster Schritt: Server → Programm → Modell → lädt → bereit", () => {
    const model = { source: "catalog" as const, installed: false, size: 147_951_465, name: "Whisper base" };
    expect(transcriptionStep(undefined)).toBe("no-server");
    expect(transcriptionStep({ engineInstalled: false, ready: false, model })).toBe("no-engine");
    expect(transcriptionStep({ engineInstalled: true, ready: false, model })).toBe("no-model");
    expect(transcriptionStep({ engineInstalled: true, ready: false, model: { ...model, downloading: true, loaded: 1 } })).toBe("downloading");
    expect(transcriptionStep({ engineInstalled: true, ready: true, model: { ...model, installed: true } })).toBe("ready");
    expect(downloadPercent({ ...model, loaded: 73_975_733 })).toBe(50);
    expect(downloadPercent({ ...model, loaded: 999_999_999 })).toBe(100);
    expect(downloadPercent({ source: "catalog", installed: false })).toBeUndefined();
    expect(megabytes(147_951_465)).toBe("148 MB");
  });

  it("Hinweise nennen den nächsten Handgriff – in der Mac-App ohne „browser“ und ohne Server-Jargon", () => {
    const small = { id: "whisper-small", active: true, source: "catalog" as const, installed: false, size: 487_601_967, name: "Whisper small" };
    const status = { engineInstalled: true, ready: false, model: small, models: [small] };
    expect(transcriptionHint("no-server", { local: false, desktop: true })).toMatch(/^Off\. Turn it on .* made on this Mac\. .*488 MB/);
    expect(transcriptionHint("no-server", { local: false, desktop: false })).toMatch(/Connect one in Sync & server/);
    expect(transcriptionHint("no-engine", { local: true, desktop: true })).toMatch(/brew install whisper-cpp/);
    expect(transcriptionHint("no-model", { local: true, desktop: true, status, choice: small })).toMatch(/once from huggingface\.co.*Clearly better in German/);
    expect(transcriptionHint("no-model", { local: true, desktop: true, status, choice: { ...small, error: "checksum mismatch" } })).toMatch(/The last download failed: checksum mismatch\./);
    expect(transcriptionHint("no-model", { local: true, desktop: true, status, choice: { ...small, error: "cancelled" } })).not.toMatch(/failed/);
    expect(transcriptionHint("downloading", { local: true, desktop: true, status, choice: { ...small, downloading: true, loaded: 243_800_984 } })).toBe("Downloading Balanced (488 MB)… 50 %");
    expect(transcriptionHint("ready", { local: true, desktop: true, status, choice: { ...small, installed: true } })).toBe("Ready with Balanced. Recordings are transcribed on this Mac; the audio doesn't leave it.");
    expect(transcriptionHint("ready", { local: false, desktop: false })).toBe("Ready. Recordings are transcribed on your server.");
  });

  it("Elija 17.11.: drei Stufen zur Auswahl; „Einschalten“ lädt das gewünschte bzw. gewählte Modell genau einmal", () => {
    const m = (id: string, o: Partial<{ installed: boolean; active: boolean; downloading: boolean; size: number }> = {}) => ({ id, source: "catalog" as const, installed: false, active: false, name: id, ...o });
    expect(modelLabel(m("whisper-base", { size: 147_951_465 }))).toBe("Fast · 148 MB");
    expect(modelLabel(m("whisper-small", { size: 487_601_967 }))).toBe("Balanced · 488 MB");
    expect(modelLabel(m("whisper-large-v3-turbo", { size: 1_624_555_275 }))).toBe("Best · 1.6 GB");
    expect(modelLabel(m("own-model", { size: 5_000_000 }))).toBe("own-model · 5 MB");
    const status = (models: ReturnType<typeof m>[], engineInstalled = true) => ({ engineInstalled, ready: false, model: models.find((x) => x.active) ?? models[0]!, models });
    const fresh = [m("whisper-base"), m("whisper-small", { active: true }), m("whisper-large-v3-turbo")];
    expect(turnOnAction(status(fresh))).toEqual({ action: "download", id: "whisper-small" });
    expect(turnOnAction(status(fresh), "whisper-large-v3-turbo")).toEqual({ action: "download", id: "whisper-large-v3-turbo" });
    expect(turnOnAction(status(fresh, false))).toBeUndefined(); // ohne Programm nichts laden
    expect(turnOnAction(status([m("whisper-base", { installed: true }), m("whisper-small", { active: true, installed: true })]))).toBeUndefined();
    expect(turnOnAction(status([m("whisper-base", { installed: true }), m("whisper-small", { active: true })]), "whisper-base")).toEqual({ action: "select", id: "whisper-base" });
    expect(turnOnAction(status([m("whisper-small", { active: true, downloading: true })]))).toBeUndefined();
    // Stand mit Modellen vom Server; ein laufender Download zählt vor „bereit mit einem anderen Modell“
    expect(transcriptionStep({ engineInstalled: true, ready: true, model: fresh[1]!, models: [m("whisper-base", { installed: true }), m("whisper-small", { active: true, downloading: true })] })).toBe("downloading");
  });

  it("Willkommensbildschirm: Text je Stand; lokaler Server startet oder scheitert mit Meldung", async () => {
    expect(meetingNotesOptionText("no-server").title).toBe("Meeting notes are off");
    expect(meetingNotesOptionText("no-server").text).toMatch(/downloads a speech model once \(488 MB\)/);
    expect(meetingNotesOptionText("downloading", { model: { size: 487_601_967, loaded: 243_800_984 } }).text).toBe("Downloading the speech model (488 MB)… 50 %. You can start now; it continues in the background.");
    expect(meetingNotesOptionText("ready").title).toBe("Meeting notes are on");
    expect(meetingNotesOptionText("no-server", { problem: "The local server didn't start." }).text).toMatch(/The local server didn't start\.$/);
    const fake = (states: { status: "off" | "starting" | "running" | "failed" | "unavailable"; error: string | undefined }[]) => {
      let i = 0; const subs = new Set<() => void>();
      return { getState: () => states[Math.min(i, states.length - 1)]!, subscribe: (fn: () => void) => { subs.add(fn); return () => void subs.delete(fn); }, next: () => { i += 1; for (const fn of [...subs]) fn(); }, subs };
    };
    const ok = fake([{ status: "starting", error: undefined }, { status: "running", error: undefined }]);
    const waiting = waitForLocalServer(ok);
    ok.next();
    await expect(waiting).resolves.toBeUndefined();
    expect(ok.subs.size).toBe(0);
    await expect(waitForLocalServer(fake([{ status: "failed", error: "Node.js is missing" }]))).rejects.toThrow("Node.js is missing");
    await expect(waitForLocalServer(fake([{ status: "starting", error: undefined }]), 20)).rejects.toThrow("in time");
  });

  it("Modell laden nur auf Aufruf, mit Token; Fehler des Servers als Meldung; Signal an den Aufnahmedienst", async () => {
    const ok = fakeFetch(() => Response.json({ installed: false, downloading: true }, { status: 202 }));
    await transcribeModel(cfg, "download", ok.f);
    await transcribeModel(cfg, "select", ok.f, "whisper-base");
    expect(ok.calls[1]!.init!.body).toBe(JSON.stringify({ action: "select", id: "whisper-base" }));
    ok.calls.pop();
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]!.url).toBe("http://127.0.0.1:8787/local/transcribe/model");
    expect(ok.calls[0]!.init!.method).toBe("POST");
    expect(ok.calls[0]!.init!.body).toBe(JSON.stringify({ action: "download" }));
    expect((ok.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    await expect(transcribeModel(cfg, "remove", fakeFetch(() => Response.json({ error: "no models folder" }, { status: 409 })).f)).rejects.toThrow("no models folder");
    let n = 0;
    const off = onTranscriptionChanged(() => { n += 1; });
    transcriptionChanged();
    off();
    transcriptionChanged();
    expect(n).toBe(1);
  });
});

describe("Transkription über den based-server (BSD-231 Teil 3c)", () => {
  it("bereit nur mit Server, Token und ready: true", async () => {
    expect(await whisperReady(undefined)).toBe(false);
    const ok = fakeFetch(() => Response.json({ engine: "whisper.cpp", ready: true }));
    expect(await whisperReady(cfg, ok.f)).toBe(true);
    expect(ok.calls[0]!.url).toBe("http://127.0.0.1:8787/local/transcribe");
    expect((ok.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(await whisperReady(cfg, fakeFetch(() => Response.json({ error: "not found" }, { status: 404 })).f)).toBe(false);
    expect(await whisperReady(cfg, fakeFetch(() => Response.json({ ready: false })).f)).toBe(false);
    expect(await whisperReady(cfg, (async () => { throw new TypeError("offline"); }) as typeof fetch)).toBe(false);
  });

  it("final schickt WAV mit Sprache und Prompt und liefert Segmente; Serverfehler als Meldung", async () => {
    const ok = fakeFetch(() => Response.json({ transcription: [{ offsets: { from: 0, to: 1000 }, text: " Hallo" }] }));
    const decode = async () => ({ channels: [new Float32Array(16_000).fill(0.1)], sampleRate: 16_000 });
    const t = serverWhisper(cfg, { fetcher: ok.f, decode });
    const r = await t.final([{ role: "microphone", offset: 2, index: 0, data: new Blob(["x"]) }], { language: "de", vocabulary: ["Based"] });
    expect(r.segments).toEqual([{ id: "w0-0", s: 2, e: 3, t: "Hallo", tr: "microphone" }]);
    const call = ok.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:8787/local/transcribe?language=de&prompt=Based");
    expect(call.init!.method).toBe("POST");
    expect((call.init!.body as Uint8Array).length).toBe(44 + 32_000);
    const bad = serverWhisper(cfg, { fetcher: fakeFetch(() => Response.json({ error: "whisper.cpp or its model is missing on the server" }, { status: 503 })).f, decode });
    await expect(bad.final([{ role: "microphone", offset: 0, index: 0, data: new Blob(["x"]) }], { vocabulary: [] })).rejects.toThrow(/model is missing/);
  });
});
