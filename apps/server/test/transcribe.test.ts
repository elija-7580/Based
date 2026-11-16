// BSD-231 Teil 3c: POST /local/transcribe – whisper.cpp auf dem eigenen Server (Meeting Notes). Hier mit einem
// Doppel für whisper-cli (Node-Skript): prüft Argumente ohne Shell, WAV-Kopf, Sprache, Fehler, Aufräumen, Reihenfolge.
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localModels } from "@based/brain";
import { checkWav, whisperFromEnv } from "../src/transcribe.js";
import { startApp, TOKEN } from "./helpers.js";

const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

function fakeWhisper(dir: string, mode: "ok" | "fail" = "ok") {
  const bin = join(dir, "whisper-cli");
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
const at = (f) => a[a.indexOf(f) + 1];
fs.appendFileSync(${JSON.stringify(join(dir, "calls.jsonl"))}, JSON.stringify(a) + "\\n");
if (${JSON.stringify(mode)} === "fail") { process.stderr.write("error: failed to read WAV file\\n"); process.exit(1); }
const wav = fs.readFileSync(at("-f"));
const seconds = (wav.length - 44) / 32000;
fs.writeFileSync(at("-of") + ".json", JSON.stringify({ result: { language: at("-l") }, transcription: [
  { offsets: { from: 0, to: 1500 }, text: " Hallo zusammen." },
  { offsets: { from: 1500, to: Math.round(seconds * 1000) }, text: " [BLANK_AUDIO]" },
] }));
`);
  chmodSync(bin, 0o755);
  const model = join(dir, "ggml-base.bin");
  writeFileSync(model, "model");
  return { bin, model };
}

const wav = (seconds: number) => localModels.encodeWav(new Float32Array(16_000 * seconds).map((_, i) => Math.sin(i / 10) * 0.2));
const post = (url: string, body: Uint8Array) => fetch(url, { method: "POST", body, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "audio/wav" } });

describe("POST /local/transcribe (BSD-231 Teil 3c)", () => {
  it("WAV → whisper-cli-JSON; Sprache und Prompt als Argumente, ohne Shell; temporäre Dateien weg", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-whisper-test-"));
    const app = await startApp({ whisper: fakeWhisper(dir) });
    apps.push(app);
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("based-whisper-") && !f.startsWith("based-whisper-test-")).length;
    const r = await post(`${app.url}/local/transcribe?language=de&prompt=${encodeURIComponent("Based, Elijá; $(rm -rf /)\u0007")}`, wav(2));
    expect(r.status).toBe(200);
    const json = (await r.json()) as localModels.WhisperJSON;
    expect(localModels.parseWhisperJSON(json)).toEqual([{ start: 0, end: 1.5, text: "Hallo zusammen." }]);
    const args = JSON.parse(readFileSync(join(dir, "calls.jsonl"), "utf8").trim()) as string[];
    expect(args[args.indexOf("-l") + 1]).toBe("de");
    expect(args[args.indexOf("--prompt") + 1]).toBe("Based, Elijá; $(rm -rf /)");
    expect(args).toContain("-oj");
    expect(readdirSync(tmpdir()).filter((f) => f.startsWith("based-whisper-") && !f.startsWith("based-whisper-test-")).length).toBe(before);
    expect((await (await fetch(`${app.url}/local/transcribe`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json())).toEqual({ engine: "whisper.cpp", ready: true });
  });

  it("Falsches Format, falsche Sprache, ohne Token, Fehler von whisper-cli", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-whisper-test-"));
    const app = await startApp({ whisper: fakeWhisper(dir, "fail") });
    apps.push(app);
    expect((await post(`${app.url}/local/transcribe`, new TextEncoder().encode("hello"))).status).toBe(400);
    const stereo = wav(1);
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect((await post(`${app.url}/local/transcribe`, stereo)).status).toBe(400);
    expect((await post(`${app.url}/local/transcribe?language=../x`, wav(1))).status).toBe(400);
    expect((await fetch(`${app.url}/local/transcribe`, { method: "POST", body: wav(1) })).status).toBe(401);
    const failed = await post(`${app.url}/local/transcribe`, wav(1));
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: string }).error).toMatch(/failed to read WAV/);
  });

  it("Mehrere Anfragen laufen nacheinander; ohne Einrichtung keine Route", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-whisper-test-"));
    const app = await startApp({ whisper: fakeWhisper(dir) });
    apps.push(app);
    const rs = await Promise.all([1, 2, 3].map(() => post(`${app.url}/local/transcribe`, wav(1))));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
    const plain = await startApp();
    apps.push(plain);
    expect((await post(`${plain.url}/local/transcribe`, wav(1))).status).toBe(404);
  });

  it("Einrichtung aus der Umgebung, WAV-Kopf", () => {
    expect(whisperFromEnv({})).toBeUndefined();
    expect(whisperFromEnv({ BASED_WHISPER_BIN: "/x/whisper-cli", BASED_WHISPER_MODEL: "/m.bin", BASED_WHISPER_THREADS: "4" })).toEqual({ bin: "/x/whisper-cli", model: "/m.bin", threads: 4 });
    expect(checkWav(wav(1))).toBeUndefined();
    expect(checkWav(localModels.encodeWav(new Float32Array(10), 44_100))).toMatch(/16 kHz/);
    expect(existsSync("/definitely/not/here")).toBe(false);
  });
});
