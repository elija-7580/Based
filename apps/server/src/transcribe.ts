// BSD-231 Teil 3c: Transkription auf dem eigenen based-server mit whisper.cpp (Meeting Notes, BSD-226). Nur der
// Besitzer; nur WAV 16 kHz mono 16 Bit (das schickt WhisperServerTranscriber, Stücke von höchstens 5 Minuten);
// whisper-cli läuft ohne Shell mit festen Argumenten, eine Datei nach der anderen, mit Zeitlimit, temporäre Dateien
// werden immer entfernt. Ohne BASED_WHISPER_BIN und BASED_WHISPER_MODEL gibt es die Route nicht (404) – das Modell
// lädt die App per Opt-in (Katalog whisper-base, BSD-231 Teil 2) bzw. legt man selbst ab.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "./log.js";
import { error, json, type Router } from "./router.js";

export interface WhisperConfig {
  /** whisper-cli (whisper.cpp ≥ 1.7). */
  bin: string;
  /** ggml-Modell (z. B. ggml-base.bin aus dem Katalog). */
  model: string;
  threads?: number;
  /** Zeitlimit je Stück (Standard 10 min). */
  timeoutMs?: number;
}

/** Größte WAV (16 MiB ≈ 8,7 min bei 16 kHz mono 16 Bit). */
export const TRANSCRIBE_BODY_LIMIT = 16 << 20;

export function whisperFromEnv(env: NodeJS.ProcessEnv): WhisperConfig | undefined {
  const bin = env.BASED_WHISPER_BIN, model = env.BASED_WHISPER_MODEL;
  if (!bin || !model) return undefined;
  const threads = Number(env.BASED_WHISPER_THREADS);
  return { bin, model, ...(Number.isInteger(threads) && threads > 0 ? { threads } : {}) };
}

/** Prüft den WAV-Kopf: PCM, mono, 16 kHz, 16 Bit. */
export function checkWav(b: Uint8Array): string | undefined {
  if (b.length < 44) return "not a WAV file";
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt ") return "not a WAV file";
  if (v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint32(24, true) !== 16_000 || v.getUint16(34, true) !== 16) return "WAV must be PCM, mono, 16 kHz, 16 bit";
  return undefined;
}

const LANGUAGE = /^(auto|[a-z]{2,3})$/;

/** Ein whisper-cli-Lauf; gibt das JSON (`-oj`) zurück. */
export async function runWhisper(cfg: WhisperConfig, wav: Uint8Array, opts: { language?: string; prompt?: string } = {}): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "based-whisper-"));
  try {
    const input = join(dir, "in.wav"), out = join(dir, "out");
    await writeFile(input, wav);
    const args = ["-m", cfg.model, "-f", input, "-oj", "-of", out, "-np", "-l", opts.language ?? "auto"];
    if (cfg.threads) args.push("-t", String(cfg.threads));
    if (opts.prompt) args.push("--prompt", opts.prompt);
    await new Promise<void>((resolve, reject) => {
      execFile(cfg.bin, args, { timeout: cfg.timeoutMs ?? 600_000, maxBuffer: 4 << 20, windowsHide: true }, (e, _stdout, stderr) => {
        if (e) reject(new Error(`whisper failed: ${(stderr || e.message).toString().trim().split("\n").slice(-2).join(" ").slice(0, 300)}`));
        else resolve();
      });
    });
    return JSON.parse(await readFile(out + ".json", "utf8"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function registerTranscribeRoutes(router: Router, cfg: WhisperConfig, log: Logger) {
  let queue: Promise<unknown> = Promise.resolve();
  router.add("GET", "/local/transcribe", () => json({ engine: "whisper.cpp", ready: existsSync(cfg.bin) && existsSync(cfg.model) }));
  router.add("POST", "/local/transcribe", async ({ url, body }) => {
    const bad = checkWav(body);
    if (bad) return error(bad, 400);
    const language = url.searchParams.get("language") ?? "auto";
    if (!LANGUAGE.test(language)) return error("language must be auto or an ISO code", 400);
    // Fachwörter als Startkontext; ohne Steuerzeichen, kurz.
    const prompt = [...(url.searchParams.get("prompt") ?? "")].map((c) => (c.charCodeAt(0) < 32 || c === "\u007f" ? " " : c)).join("").slice(0, 400).trim();
    if (!existsSync(cfg.bin) || !existsSync(cfg.model)) return error("whisper.cpp or its model is missing on the server", 503);
    const started = Date.now();
    const run = queue.then(() => runWhisper(cfg, body, { language, ...(prompt ? { prompt } : {}) }));
    queue = run.catch(() => undefined);
    try {
      const result = await run;
      log.info("transcribed", { seconds: Math.round((body.length - 44) / 32_000), ms: Date.now() - started });
      return json(result);
    } catch (e) {
      log.warning("transcribe failed", { message: e instanceof Error ? e.message : String(e) });
      return error(e instanceof Error ? e.message : String(e), 500);
    }
  }, { bodyLimit: TRANSCRIBE_BODY_LIMIT });
}
