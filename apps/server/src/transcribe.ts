// BSD-231 Teil 3c: Transkription auf dem eigenen based-server mit whisper.cpp (Meeting Notes, BSD-226). Nur der
// Besitzer; nur WAV 16 kHz mono 16 Bit (das schickt WhisperServerTranscriber, Stücke von höchstens 5 Minuten);
// whisper-cli läuft ohne Shell mit festen Argumenten, eine Datei nach der anderen, mit Zeitlimit, temporäre Dateien
// werden immer entfernt. Ohne BASED_WHISPER_BIN gibt es die Route nicht (404). Modell: BASED_WHISPER_MODEL (eigene
// Datei) oder – Teil 3d – whisper-base aus dem Katalog, das der Besitzer ausdrücklich laden lässt
// (POST /local/transcribe/model {"action":"download"}; feste Quelle, Größe und SHA-256 geprüft, Ordner `<db>.models`).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { localModels } from "@based/brain";
import type { Logger } from "./log.js";
import { FileModelStore } from "./models.js";
import { error, json, type Router } from "./router.js";

export interface WhisperConfig {
  /** whisper-cli (whisper.cpp ≥ 1.7). Leer: `find` sucht es (lokaler Server der Mac-App). */
  bin: string;
  /**
   * Feedback 17. 11.: Der lokale Server der Mac-App bekommt kein BASED_WHISPER_BIN – er sucht ein installiertes
   * whisper-cli selbst, bei jeder Anfrage neu (nach `brew install whisper-cpp` ohne Neustart bereit).
   */
  find?: () => string | undefined;
  /** Eigenes ggml-Modell; ohne: whisper-base aus dem Katalog in `modelsDir` (erst nach ausdrücklichem Laden). */
  model?: string;
  /** Ordner für Modelle aus dem Katalog (Standard `<db>.models`). */
  modelsDir?: string;
  /** Tests: Netz und Katalogeintrag. */
  fetch?: typeof fetch;
  spec?: localModels.LocalModelSpec;
  threads?: number;
  /** Zeitlimit je Stück (Standard 10 min). */
  timeoutMs?: number;
}

/** Größte WAV (16 MiB ≈ 8,7 min bei 16 kHz mono 16 Bit). */
export const TRANSCRIBE_BODY_LIMIT = 16 << 20;

/** Namen des Programms: `whisper-cli` (whisper.cpp ≥ 1.7.4, Homebrew `whisper-cpp`), davor `whisper-cpp`. */
export const WHISPER_NAMES = ["whisper-cli", "whisper-cpp"] as const;
/** Übliche Orte auf dem Mac, falls der PATH der Login-Shell sie nicht nennt (Homebrew auf Apple Silicon und Intel). */
export const WHISPER_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

/** Sucht whisper-cli im PATH und an den üblichen Orten; nur absolute Ordner, erste vorhandene Datei gewinnt. */
export function findWhisper(path: string | undefined, exists: (file: string) => boolean = existsSync, extra: readonly string[] = WHISPER_DIRS): string | undefined {
  const seen = new Set<string>();
  for (const dir of [...(path ?? "").split(delimiter), ...extra]) {
    if (!dir.startsWith("/") || seen.has(dir)) continue;
    seen.add(dir);
    for (const name of WHISPER_NAMES) {
      const file = join(dir, name);
      if (exists(file)) return file;
    }
  }
  return undefined;
}

/**
 * Einrichtung aus der Umgebung. Mit BASED_WHISPER_BIN wie bisher. `local` (lokaler Server der Mac-App): auch ohne
 * die Variable gibt es die Routen – das Programm wird gesucht, und GET /local/transcribe sagt, was noch fehlt.
 */
export function whisperFromEnv(env: NodeJS.ProcessEnv, opts: { local?: boolean } = {}): WhisperConfig | undefined {
  const bin = env.BASED_WHISPER_BIN, model = env.BASED_WHISPER_MODEL;
  if (!bin && !opts.local) return undefined;
  const threads = Number(env.BASED_WHISPER_THREADS);
  return {
    bin: bin ?? "", ...(bin ? {} : { find: () => findWhisper(process.env.PATH) }),
    ...(model ? { model } : {}), ...(Number.isInteger(threads) && threads > 0 ? { threads } : {}),
  };
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
export async function runWhisper(cfg: Pick<WhisperConfig, "bin" | "threads" | "timeoutMs"> & { model: string }, wav: Uint8Array, opts: { language?: string; prompt?: string } = {}): Promise<unknown> {
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

/** Modell aus dem Katalog auf dem Server: Stand, Laden (im Hintergrund), Abbrechen, Entfernen. */
class ServerModel {
  readonly spec: localModels.LocalModelSpec;
  readonly store: FileModelStore;
  private readonly manager: localModels.LocalModelManager;
  private installed: boolean | undefined;
  private download: { ctl: AbortController; loaded: number; total: number } | undefined;
  private lastError: string | undefined;

  constructor(dir: string, cfg: WhisperConfig, private readonly log: Logger) {
    this.spec = cfg.spec ?? localModels.catalogFor("transcription")!;
    this.store = new FileModelStore(dir);
    this.manager = new localModels.LocalModelManager({
      store: this.store,
      fetch: cfg.fetch ?? ((...a) => fetch(...a)),
      // Der Besitzer hat ausdrücklich „laden“ gesagt (eigene Route); sonst geht keine Anfrage hinaus.
      consent: () => new Set(["transcription"]),
      server: () => undefined,
    });
  }

  /** Pfad der ggml-Datei, wenn vollständig und geprüft. */
  async path(): Promise<string | undefined> {
    if (this.download) return undefined;
    this.installed ??= await this.manager.installed(this.spec);
    const file = this.spec.files.find((f) => f.path.endsWith(".bin")) ?? this.spec.files[0]!;
    return this.installed ? this.store.pathOf(localModels.storePath(this.spec, file)) : undefined;
  }

  async state() {
    const ready = (await this.path()) !== undefined;
    return {
      id: this.spec.id, name: this.spec.name, license: this.spec.license, size: this.spec.files.reduce((n, f) => n + f.size, 0),
      installed: ready, downloading: this.download !== undefined,
      ...(this.download ? { loaded: this.download.loaded } : {}), ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  start() {
    if (this.download) return;
    const ctl = new AbortController();
    const d = { ctl, loaded: 0, total: this.spec.files.reduce((n, f) => n + f.size, 0) };
    this.download = d;
    this.lastError = undefined;
    this.installed = undefined;
    void this.manager.download(this.spec, { signal: ctl.signal, onProgress: (p) => { d.loaded = p.loaded; } }).then(
      () => { this.installed = true; this.log.info("whisper model ready", { model: this.spec.id }); },
      (e: unknown) => {
        this.installed = false;
        this.lastError = ctl.signal.aborted ? "cancelled" : e instanceof Error ? e.message : String(e);
        this.log.warning("whisper model download failed", { message: this.lastError });
      },
    ).finally(() => { if (this.download === d) this.download = undefined; });
  }

  cancel() { this.download?.ctl.abort(); }

  async remove() {
    this.cancel();
    await this.manager.remove(this.spec);
    this.installed = false;
  }
}

export function registerTranscribeRoutes(router: Router, cfg: WhisperConfig, log: Logger) {
  let queue: Promise<unknown> = Promise.resolve();
  const catalog = !cfg.model && cfg.modelsDir ? new ServerModel(cfg.modelsDir, cfg, log) : undefined;
  const modelPath = async () => (cfg.model ? (existsSync(cfg.model) ? cfg.model : undefined) : await catalog?.path());
  const binPath = () => (cfg.bin && existsSync(cfg.bin) ? cfg.bin : cfg.find?.());
  router.add("GET", "/local/transcribe", async () => json({
    engine: "whisper.cpp",
    // Feedback 17. 11.: getrennt melden, was fehlt – das Programm oder das Modell (Einstellungen → Meeting notes).
    engineInstalled: binPath() !== undefined,
    ready: binPath() !== undefined && (await modelPath()) !== undefined,
    model: cfg.model ? { source: "file", installed: existsSync(cfg.model) } : catalog ? { source: "catalog", ...(await catalog.state()) } : { source: "none", installed: false },
  }));
  // Teil 3d: Modell aus dem Katalog laden lassen (nur Besitzer, nur auf ausdrücklichen Aufruf).
  router.add("POST", "/local/transcribe/model", async ({ body }) => {
    if (!catalog) return error(cfg.model ? "the server uses its own model file (BASED_WHISPER_MODEL)" : "no models folder", 409);
    let action: unknown;
    try { action = (JSON.parse(new TextDecoder().decode(body)) as { action?: unknown }).action; } catch { return error("JSON body {action}", 400); }
    if (action === "download") catalog.start();
    else if (action === "cancel") catalog.cancel();
    else if (action === "remove") await catalog.remove();
    else return error("action must be download, cancel or remove", 400);
    return json(await catalog.state(), action === "download" ? 202 : 200);
  }, { bodyLimit: 1024 });
  router.add("POST", "/local/transcribe", async ({ url, body }) => {
    const bad = checkWav(body);
    if (bad) return error(bad, 400);
    const language = url.searchParams.get("language") ?? "auto";
    if (!LANGUAGE.test(language)) return error("language must be auto or an ISO code", 400);
    // Fachwörter als Startkontext; ohne Steuerzeichen, kurz.
    const prompt = [...(url.searchParams.get("prompt") ?? "")].map((c) => (c.charCodeAt(0) < 32 || c === "\u007f" ? " " : c)).join("").slice(0, 400).trim();
    const model = await modelPath();
    const bin = binPath();
    if (!bin || !model) return error("whisper.cpp or its model is missing on the server", 503);
    const started = Date.now();
    const run = queue.then(() => runWhisper({ ...cfg, bin, model }, body, { language, ...(prompt ? { prompt } : {}) }));
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
