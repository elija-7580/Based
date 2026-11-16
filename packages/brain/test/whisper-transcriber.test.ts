// BSD-231 Teil 3c: WhisperServerTranscriber – Spuren dekodiert → 16 kHz mono → WAV-Stücke an den eigenen Server →
// Segmente mit Zeiten im Meeting. Server und Dekoder sind Doppel.
import { describe, expect, it } from "vitest";
import { localModels } from "../src/index.js";

const { WhisperServerTranscriber, encodeWav, parseWhisperJSON, splitAtQuiet, toMono16k, WHISPER_RATE } = localModels;

describe("Audio für whisper.cpp (BSD-231 Teil 3c)", () => {
  it("Kanäle mitteln und auf 16 kHz bringen", () => {
    const left = new Float32Array(48_000).fill(0.5), right = new Float32Array(48_000).fill(-0.1);
    const mono = toMono16k([left, right], 48_000);
    expect(mono.length).toBe(16_000);
    expect(mono[100]).toBeCloseTo(0.2, 5);
    expect(toMono16k([new Float32Array(8_000).fill(0.3)], 8_000).length).toBe(16_000);
    expect(toMono16k([new Float32Array(16)], 16_000)).toHaveLength(16);
    expect(toMono16k([], 48_000)).toHaveLength(0);
  });

  it("WAV-Kopf und Werte (16 Bit, mono, 16 kHz), übersteuerte Werte begrenzt", () => {
    const w = encodeWav(Float32Array.from([0, 1, -1, 2]));
    const v = new DataView(w.buffer);
    expect(new TextDecoder().decode(w.subarray(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(16_000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(40, true)).toBe(8);
    expect([0, 1, 2, 3].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767]);
  });

  it("whisper-cli-JSON: Zeiten in Sekunden, leere und [BLANK_AUDIO] fallen weg", () => {
    expect(parseWhisperJSON({ transcription: [
      { offsets: { from: 0, to: 2340 }, text: " Guten Morgen." }, { offsets: { from: 2340, to: 3000 }, text: " [BLANK_AUDIO]" },
      { offsets: { from: 3000, to: 3500 }, text: "   " }, { offsets: { from: 4000, to: 5200 }, text: " Los geht's" },
    ] })).toEqual([{ start: 0, end: 2.34, text: "Guten Morgen." }, { start: 4, end: 5.2, text: "Los geht's" }]);
    expect(parseWhisperJSON({})).toEqual([]);
  });

  it("Lange Aufnahmen: Stücke ≤ 5 min, Schnitt an der leisesten Stelle davor", () => {
    const rate = 1_000; // klein für den Test
    const pcm = new Float32Array(rate * 700).fill(0.5);
    pcm.fill(0, rate * 295, rate * 296); // Stille kurz vor der 300-s-Grenze
    const parts = splitAtQuiet(pcm, 300, rate);
    expect(parts[0]![1]).toBeGreaterThanOrEqual(rate * 295);
    expect(parts[0]![1]).toBeLessThanOrEqual(rate * 296);
    for (const [a, b] of parts) expect(b - a).toBeLessThanOrEqual(300 * rate);
    expect(parts.at(-1)![1]).toBe(pcm.length);
    for (let i = 1; i < parts.length; i++) expect(parts[i]![0]).toBe(parts[i - 1]![1]);
    expect(splitAtQuiet(new Float32Array(10))).toEqual([[0, 10]]);
  });

  it("final: jede Spur einzeln, Zeiten ab Spur-Beginn, Rolle; Prompt aus dem Vokabular, Sprache durchgereicht", async () => {
    const posts: { seconds: number; language: string | undefined; prompt: string | undefined }[] = [];
    const t = new WhisperServerTranscriber({
      async decode(data) { return { channels: [new Float32Array((data as { seconds: number }).seconds * 48_000).fill(0.1)], sampleRate: 48_000 }; },
      async post(wav, o) {
        const seconds = (wav.length - 44) / 2 / WHISPER_RATE;
        posts.push({ seconds, language: o.language, prompt: o.prompt });
        return { transcription: [{ offsets: { from: 500, to: 1500 }, text: ` Teil ${posts.length}` }] };
      },
    });
    const r = await t.final([
      { role: "microphone", offset: 0, index: 0, data: { seconds: 2 } },
      { role: "system", offset: 0.25, index: 1, data: { seconds: 3 } },
      { role: "upload", offset: 10, index: 2, data: undefined },
    ], { language: "de", vocabulary: ["Based", "Elijá"] });
    expect(posts).toEqual([{ seconds: 2, language: "de", prompt: "Based, Elijá" }, { seconds: 3, language: "de", prompt: "Based, Elijá" }]);
    expect(r.segments).toEqual([
      { id: "w0-0", s: 0.5, e: 1.5, t: "Teil 1", tr: "microphone" },
      { id: "w1-0", s: 0.75, e: 1.75, t: "Teil 2", tr: "system" },
    ]);
  });
});
