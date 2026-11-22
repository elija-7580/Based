// BSD-231 Teil 3c: POST /local/transcribe – whisper.cpp auf dem eigenen Server (Meeting Notes). Hier mit einem
// Doppel für whisper-cli (Node-Skript): prüft Argumente ohne Shell, WAV-Kopf, Sprache, Fehler, Aufräumen, Reihenfolge.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localModels } from "@based/brain";
import { defaultModelsDir, FileModelStore } from "../src/models.js";
import { checkWav, downloadModelFile, findWhisper, whisperFromEnv } from "../src/transcribe.js";
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
    const r = await post(`${app.url}/local/transcribe?language=de&prompt=${encodeURIComponent("Based, Elijá; $(rm -rf /)\u0007")}`, wav(2));
    expect(r.status).toBe(200);
    const json = (await r.json()) as localModels.WhisperJSON;
    expect(localModels.parseWhisperJSON(json)).toEqual([{ start: 0, end: 1.5, text: "Hallo zusammen." }]);
    const args = JSON.parse(readFileSync(join(dir, "calls.jsonl"), "utf8").trim()) as string[];
    expect(args[args.indexOf("-l") + 1]).toBe("de");
    expect(args[args.indexOf("--prompt") + 1]).toBe("Based, Elijá; $(rm -rf /)");
    expect(args).toContain("-oj");
    // BSD-650: genau der Arbeitsordner dieses Laufs (Pfad aus den Argumenten) ist weg – nicht alle based-whisper-*
    // im gemeinsamen /tmp zählen, dort legen parallele Läufe (andere Arbeitsordner) eigene an.
    const work = dirname(args[args.indexOf("-f") + 1]!);
    expect(work.startsWith(join(tmpdir(), "based-whisper-"))).toBe(true);
    expect(existsSync(work)).toBe(false);
    expect((await (await fetch(`${app.url}/local/transcribe`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json())).toEqual({ engine: "whisper.cpp", engineInstalled: true, ready: true, model: { source: "file", installed: true } });
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
    // BSD-650: auch nach einem Fehler ist der Arbeitsordner dieses Laufs weg
    const calls = readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    const work = dirname(calls.at(-1)![calls.at(-1)!.indexOf("-f") + 1]!);
    expect(existsSync(work)).toBe(false);
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

  it("Teil 3d: Modell aus dem Katalog erst auf ausdrücklichen Aufruf laden (geprüft), dann transkribieren, entfernen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-whisper-test-"));
    const { bin } = fakeWhisper(dir);
    const bytes = new TextEncoder().encode("ggml fake model bytes");
    const spec: localModels.LocalModelSpec = { id: "whisper-test", purpose: "transcription", name: "Whisper test", version: "v1", license: "MIT",
      files: [{ path: "ggml-test.bin", url: "https://example.invalid/ggml-test.bin", size: bytes.length, sha256: await localModels.sha256Hex(bytes) }] };
    const requested: string[] = [];
    const fakeFetch = (async (u: string | URL | Request) => { requested.push(String(u)); return new Response(bytes); }) as typeof fetch;
    const modelsDir = join(dir, "models");
    const app = await startApp({ whisper: { bin, modelsDir, spec, fetch: fakeFetch } });
    apps.push(app);
    const state = async () => (await (await fetch(`${app.url}/local/transcribe`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()) as { ready: boolean; model: { installed: boolean; downloading: boolean; source: string } };
    expect(await state()).toMatchObject({ ready: false, model: { source: "catalog", installed: false, downloading: false } });
    expect(requested).toEqual([]); // ohne Aufruf keine Anfrage
    expect((await post(`${app.url}/local/transcribe`, wav(1))).status).toBe(503);
    const model = (action: string) => fetch(`${app.url}/local/transcribe/model`, { method: "POST", body: JSON.stringify({ action }), headers: { Authorization: `Bearer ${TOKEN}` } });
    expect((await model("download")).status).toBe(202);
    await expect.poll(async () => (await state()).ready, { timeout: 5000 }).toBe(true);
    expect(requested).toEqual(["https://example.invalid/ggml-test.bin"]);
    expect(readFileSync(join(modelsDir, "whisper-test", "v1", "ggml-test.bin"), "utf8")).toBe("ggml fake model bytes");
    expect((await post(`${app.url}/local/transcribe`, wav(1))).status).toBe(200);
    const args = JSON.parse(readFileSync(join(dir, "calls.jsonl"), "utf8").trim()) as string[];
    expect(args[args.indexOf("-m") + 1]).toBe(join(modelsDir, "whisper-test", "v1", "ggml-test.bin"));
    expect((await model("remove")).status).toBe(200);
    expect((await state()).ready).toBe(false);
    expect((await model("explode")).status).toBe(400);
  });

  it("Lokaler Server der Mac-App: findet ein installiertes whisper-cli selbst und sagt, was fehlt (Feedback 17. 11.)", async () => {
    // Suche: PATH zuerst, dann die üblichen Homebrew-Orte; alter Name whisper-cpp zählt; relative Einträge nie.
    const has = (...files: string[]) => (f: string) => files.includes(f);
    expect(findWhisper("/a:/b", has("/b/whisper-cli"))).toBe("/b/whisper-cli");
    expect(findWhisper("/a", has("/opt/homebrew/bin/whisper-cli"))).toBe("/opt/homebrew/bin/whisper-cli");
    expect(findWhisper("/a", has("/a/whisper-cpp"))).toBe("/a/whisper-cpp");
    expect(findWhisper("rel:.:", has("rel/whisper-cli", "whisper-cli"), [])).toBeUndefined();
    expect(findWhisper(undefined, () => false)).toBeUndefined();
    // Ohne BASED_WHISPER_BIN: nur der lokale Server bekommt die Routen.
    expect(whisperFromEnv({})).toBeUndefined();
    expect(whisperFromEnv({}, { local: true })).toMatchObject({ bin: "" });
    expect(whisperFromEnv({ BASED_WHISPER_BIN: "/x/whisper-cli" }, { local: true })).toEqual({ bin: "/x/whisper-cli" });
    // BSD-231: das mit der Mac-App gelieferte Programm geht vor einem installierten; fehlt die Datei, wird gesucht
    const bundledDir = mkdtempSync(join(tmpdir(), "based-whisper-bundled-"));
    writeFileSync(join(bundledDir, "whisper-cli"), "x");
    expect(whisperFromEnv({ BASED_WHISPER_BUNDLED: join(bundledDir, "whisper-cli") }, { local: true })?.find?.()).toBe(join(bundledDir, "whisper-cli"));
    expect(whisperFromEnv({ BASED_WHISPER_BUNDLED: join(bundledDir, "missing") }, { local: true })?.find?.()).not.toBe(join(bundledDir, "missing"));

    const dir = mkdtempSync(join(tmpdir(), "based-whisper-test-"));
    const { model } = fakeWhisper(dir);
    let installed = false;
    const app = await startApp({ whisper: { bin: "", find: () => (installed ? join(dir, "whisper-cli") : undefined), model } });
    apps.push(app);
    const state = async () => (await (await fetch(`${app.url}/local/transcribe`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()) as { ready: boolean; engineInstalled: boolean };
    expect(await state()).toMatchObject({ ready: false, engineInstalled: false });
    expect((await post(`${app.url}/local/transcribe`, wav(1))).status).toBe(503);
    installed = true; // „brew install whisper-cpp“, ohne Neustart
    expect(await state()).toMatchObject({ ready: true, engineInstalled: true });
    expect((await post(`${app.url}/local/transcribe`, wav(1))).status).toBe(200);
  });

  it("Elija 17.11.: mehrere Modelle – Auswahl, Laden macht es zum gewählten, Rückfall auf ein geladenes, Auswahl bleibt nach Neustart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-whisper-test-"));
    const { bin } = fakeWhisper(dir);
    const mk = async (id: string, text: string): Promise<localModels.LocalModelSpec> => {
      const bytes = new TextEncoder().encode(text);
      return { id, purpose: "transcription", name: id, version: "v1", license: "MIT", files: [{ path: `ggml-${id}.bin`, url: `https://example.invalid/${id}.bin`, size: bytes.length, sha256: await localModels.sha256Hex(bytes) }] };
    };
    const specs = [await mk("fast", "fast model"), await mk("best", "the best model")];
    const requested: string[] = [];
    const fakeFetch = (async (u: string | URL | Request) => { requested.push(String(u)); return new Response(String(u).includes("fast") ? "fast model" : "the best model"); }) as typeof fetch;
    const modelsDir = join(dir, "models");
    const cfg = { bin, modelsDir, specs, fetch: fakeFetch };
    type State = { ready: boolean; model: { id: string; installed: boolean }; models: { id: string; installed: boolean; active: boolean }[] };
    const run = async (url: string) => {
      const state = async () => (await (await fetch(`${url}/local/transcribe`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()) as State;
      const model = (action: string, id?: string) => fetch(`${url}/local/transcribe/model`, { method: "POST", body: JSON.stringify({ action, ...(id ? { id } : {}) }), headers: { Authorization: `Bearer ${TOKEN}` } });
      return { state, model };
    };
    const app = await startApp({ whisper: cfg });
    const a = await run(app.url);
    // ohne Vermerk ist das erste gewählt (der echte Katalog nimmt small); nichts wird von selbst geladen
    expect((await a.state()).models).toEqual([expect.objectContaining({ id: "fast", active: true, installed: false }), expect.objectContaining({ id: "best", active: false, installed: false })]);
    expect(requested).toEqual([]);
    expect((await a.model("download", "nope")).status).toBe(404);
    // „best“ laden: wird das gewählte; nur diese Datei wird geholt
    expect((await a.model("download", "best")).status).toBe(202);
    await expect.poll(async () => (await a.state()).ready, { timeout: 5000 }).toBe(true);
    expect(requested).toEqual(["https://example.invalid/best.bin"]);
    expect((await a.state()).model).toMatchObject({ id: "best", installed: true });
    expect(readFileSync(join(modelsDir, "best", "v1", "ggml-best.bin.sha256"), "utf8")).toBe(specs[1]!.files[0]!.sha256);
    // „fast“ nur wählen (nicht geladen): transkribiert wird mit dem geladenen „best“
    expect((await a.model("select", "fast")).status).toBe(200);
    expect(await a.state()).toMatchObject({ ready: true, model: { id: "fast", installed: false } });
    expect((await post(`${app.url}/local/transcribe`, wav(1))).status).toBe(200);
    const args = JSON.parse(readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").at(-1)!) as string[];
    expect(args[args.indexOf("-m") + 1]).toBe(join(modelsDir, "best", "v1", "ggml-best.bin"));
    // Neustart: Auswahl und geladenes Modell bleiben
    await app.close();
    const again = await startApp({ whisper: cfg });
    apps.push(again);
    const b = await run(again.url);
    expect(await b.state()).toMatchObject({ ready: true, model: { id: "fast" }, models: [{ id: "fast", active: true, installed: false }, { id: "best", active: false, installed: true }] });
    expect((await b.model("remove", "best")).status).toBe(200);
    expect((await b.state()).ready).toBe(false);
    expect(existsSync(join(modelsDir, "best", "v1", "ggml-best.bin"))).toBe(false);
  });

  it("Elija 17.11.: Modelldatei direkt auf die Platte – Fortsetzen per Range, falsche Prüfsumme wird verworfen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-whisper-test-"));
    const bytes = new TextEncoder().encode("0123456789abcdefghij");
    const file = { path: "m.bin", url: "https://example.invalid/m.bin", size: bytes.length, sha256: await localModels.sha256Hex(bytes) };
    const dest = join(dir, "sub", "m.bin");
    // erster Versuch bricht nach 8 Bytes ab (Verbindung weg)
    const ranges: (string | undefined)[] = [];
    const cut = (async (_u: string | URL | Request, init?: RequestInit) => {
      ranges.push((init?.headers as Record<string, string> | undefined)?.Range);
      let sent = false;
      return new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(bytes.slice(0, 8)); } else c.error(new Error("connection lost")); } }));
    }) as typeof fetch;
    await expect(downloadModelFile(file, dest, { fetch: cut })).rejects.toThrow("connection lost");
    expect(readFileSync(dest + ".part", "utf8")).toBe("01234567");
    expect(existsSync(dest)).toBe(false);
    // zweiter Versuch setzt fort (206) und meldet den Fortschritt ab dem vorhandenen Teil
    const progress: number[] = [];
    const resume = (async (_u: string | URL | Request, init?: RequestInit) => {
      const range = (init?.headers as Record<string, string> | undefined)?.Range;
      ranges.push(range);
      const from = Number(/bytes=(\d+)-/.exec(range ?? "")?.[1] ?? 0);
      return new Response(bytes.slice(from), { status: from ? 206 : 200 });
    }) as typeof fetch;
    await downloadModelFile(file, dest, { fetch: resume, onProgress: (n) => progress.push(n) });
    expect(ranges).toEqual([undefined, "bytes=8-"]);
    expect(progress.at(-1)).toBe(bytes.length);
    expect(readFileSync(dest, "utf8")).toBe("0123456789abcdefghij");
    expect(existsSync(dest + ".part")).toBe(false);
    // Server ohne Range (200): von vorn, Ergebnis stimmt trotzdem
    const dest2 = join(dir, "m2.bin");
    writeFileSync(dest2 + ".part", "XXXX");
    await downloadModelFile(file, dest2, { fetch: (async () => new Response(bytes)) as typeof fetch });
    expect(readFileSync(dest2, "utf8")).toBe("0123456789abcdefghij");
    // falscher Inhalt gleicher Länge: Fehler, nichts bleibt liegen; nur https
    const dest3 = join(dir, "m3.bin");
    await expect(downloadModelFile(file, dest3, { fetch: (async () => new Response("X".repeat(bytes.length))) as typeof fetch })).rejects.toThrow("checksum mismatch");
    expect(existsSync(dest3)).toBe(false);
    expect(existsSync(dest3 + ".part")).toBe(false);
    await expect(downloadModelFile(file, dest3, { fetch: (async () => new Response("too short")) as typeof fetch })).rejects.toThrow(/size 9, expected 20/);
    await expect(downloadModelFile({ ...file, url: "http://example.invalid/m.bin" }, dest3, { fetch: cut })).rejects.toThrow("only https");
  });

  it("Einrichtung aus der Umgebung, WAV-Kopf", () => {
    expect(whisperFromEnv({})).toBeUndefined();
    expect(whisperFromEnv({ BASED_WHISPER_BIN: "/x/whisper-cli", BASED_WHISPER_MODEL: "/m.bin", BASED_WHISPER_THREADS: "4" })).toEqual({ bin: "/x/whisper-cli", model: "/m.bin", threads: 4 });
    expect(whisperFromEnv({ BASED_WHISPER_BIN: "/x/whisper-cli" })).toEqual({ bin: "/x/whisper-cli" });
    expect(defaultModelsDir("/data/based.sqlite")).toBe("/data/based.models");
    expect(defaultModelsDir(":memory:")).toBeUndefined();
    const store = new FileModelStore(mkdtempSync(join(tmpdir(), "based-models-")));
    expect(() => store.pathOf("../x")).toThrow(/invalid/);
    expect(() => store.pathOf("a//b")).toThrow(/invalid/);
    expect(checkWav(wav(1))).toBeUndefined();
    expect(checkWav(localModels.encodeWav(new Float32Array(10), 44_100))).toMatch(/16 kHz/);
    expect(existsSync("/definitely/not/here")).toBe(false);
  });
});
