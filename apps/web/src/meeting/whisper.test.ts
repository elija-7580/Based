// BSD-231 Teil 3c: Transkription über den eigenen Server – nur wenn er sie anbietet; Anfrage mit Token, Sprache und
// Fachwörtern; Fehler des Servers kommen als verständliche Meldung an.
import { describe, expect, it } from "vitest";
import { serverWhisper, whisperReady } from "./whisper.js";

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
