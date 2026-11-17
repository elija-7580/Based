// BSD-231 Teil 3c: Transkription auf dem eigenen based-server mit whisper.cpp (Meeting Notes, BSD-226). Nur der
// Besitzer; nur WAV 16 kHz mono 16 Bit (das schickt WhisperServerTranscriber, Stücke von höchstens 5 Minuten);
// whisper-cli läuft ohne Shell mit festen Argumenten, eine Datei nach der anderen, mit Zeitlimit, temporäre Dateien
// werden immer entfernt. Ohne BASED_WHISPER_BIN gibt es die Route nicht (404). Modell: BASED_WHISPER_MODEL (eigene
// Datei) oder – Teil 3d – whisper-base aus dem Katalog, das der Besitzer ausdrücklich laden lässt
// (POST /local/transcribe/model {"action":"download"}; feste Quelle, Größe und SHA-256 geprüft, Ordner `<db>.models`).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
  /** Tests: Netz und Katalogeintrag (einer) bzw. Katalogeinträge (mehrere; der erste ist ohne Standard der gewählte). */
  fetch?: typeof fetch;
  spec?: localModels.LocalModelSpec;
  specs?: readonly localModels.LocalModelSpec[];
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
    // BSD-231: zuerst das mit der Mac-App gelieferte Programm (BASED_WHISPER_BUNDLED), dann ein installiertes.
    bin: bin ?? "", ...(bin ? {} : { find: () => (env.BASED_WHISPER_BUNDLED && existsSync(env.BASED_WHISPER_BUNDLED) ? env.BASED_WHISPER_BUNDLED : findWhisper(process.env.PATH)) }),
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

/**
 * Elija 17.11.: eine Modelldatei direkt auf die Platte laden – ohne sie im Speicher zu halten (large-v3-turbo hat
 * 1,6 GB). Schreibt nach `<ziel>.part`, rechnet SHA-256 mit, setzt einen abgebrochenen Download per Range fort und
 * benennt erst nach Größen- und Prüfsummen-Kontrolle um. Wirft bei falscher Größe oder Prüfsumme (Teil wird gelöscht).
 */
export async function downloadModelFile(file: localModels.LocalModelFile, dest: string, o: { fetch: typeof fetch; signal?: AbortSignal; onProgress?: (loaded: number) => void }): Promise<void> {
  if (!file.url?.startsWith("https://")) throw new Error(`${file.path}: only https sources`);
  mkdirSync(dirname(dest), { recursive: true });
  const part = dest + ".part";
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have >= file.size) { rmSync(part, { force: true }); have = 0; }
  const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {};
  const res = await o.fetch(file.url, { credentials: "omit", headers, ...(o.signal ? { signal: o.signal } : {}) });
  if (!res.ok) throw new Error(`${file.path}: HTTP ${res.status}`);
  // Der Server ignoriert Range (200 statt 206): von vorn.
  if (have > 0 && res.status !== 206) { rmSync(part, { force: true }); have = 0; }
  const hash = createHash("sha256");
  if (have > 0) for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
  const out = createWriteStream(part, { flags: have > 0 ? "a" : "w" });
  let got = have;
  try {
    const reader = res.body?.getReader();
    if (!reader) throw new Error(`${file.path}: empty response`);
    for (;;) {
      o.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > file.size) { await reader.cancel(); throw new Error(`${file.path}: larger than expected`); }
      hash.update(value);
      if (!out.write(value)) await once(out, "drain");
      o.onProgress?.(got);
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  if (got !== file.size) throw new Error(`${file.path}: size ${got}, expected ${file.size}`);
  if (hash.digest("hex") !== file.sha256) { rmSync(part, { force: true }); throw new Error(`${file.path}: checksum mismatch`); }
  renameSync(part, dest);
  writeFileSync(dest + ".sha256", file.sha256);
}

/** SHA-256 einer Datei, ohne sie ganz in den Speicher zu lesen. */
async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Ein Modell aus dem Katalog auf dem Server: Stand, Laden (im Hintergrund), Abbrechen, Entfernen. */
class ServerModel {
  readonly store: FileModelStore;
  private installed: boolean | undefined;
  private download: { ctl: AbortController; loaded: number; total: number } | undefined;
  private lastError: string | undefined;

  constructor(readonly spec: localModels.LocalModelSpec, dir: string, private readonly cfg: WhisperConfig, private readonly log: Logger) {
    this.store = new FileModelStore(dir);
  }

  private get size() { return this.spec.files.reduce((n, f) => n + f.size, 0); }
  private fileOf(f: localModels.LocalModelFile) { return this.store.pathOf(localModels.storePath(this.spec, f)); }

  /**
   * Vollständig und geprüft? Größe muss stimmen; die Prüfsumme steht nach dem Laden in `<datei>.sha256` (sonst würde
   * jeder Start 1,6 GB lesen). Fehlt der Vermerk (Datei von einer älteren Version geladen), wird einmal nachgerechnet.
   */
  private async check(): Promise<boolean> {
    for (const f of this.spec.files) {
      const file = this.fileOf(f);
      if (!existsSync(file) || statSync(file).size !== f.size) return false;
      const mark = file + ".sha256";
      if (existsSync(mark) && (await readFile(mark, "utf8")).trim() === f.sha256) continue;
      if ((await fileSha256(file)) !== f.sha256) return false;
      writeFileSync(mark, f.sha256);
    }
    return true;
  }

  /** Pfad der ggml-Datei, wenn vollständig und geprüft. */
  async path(): Promise<string | undefined> {
    if (this.download) return undefined;
    this.installed ??= await this.check();
    const file = this.spec.files.find((f) => f.path.endsWith(".bin")) ?? this.spec.files[0]!;
    return this.installed ? this.fileOf(file) : undefined;
  }

  async state() {
    const ready = (await this.path()) !== undefined;
    return {
      id: this.spec.id, name: this.spec.name, license: this.spec.license, size: this.size,
      installed: ready, downloading: this.download !== undefined,
      ...(this.download ? { loaded: this.download.loaded } : {}), ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  start() {
    if (this.download) return;
    const ctl = new AbortController();
    const d = { ctl, loaded: 0, total: this.size };
    this.download = d;
    this.lastError = undefined;
    this.installed = undefined;
    const fetcher = this.cfg.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    void (async () => {
      const errors = localModels.validateSpec(this.spec);
      if (errors.length) throw new Error(errors.join("; "));
      let before = 0;
      for (const f of this.spec.files) {
        const file = this.fileOf(f);
        if (!(existsSync(file) && statSync(file).size === f.size && (await fileSha256(file)) === f.sha256)) {
          const base = before;
          await downloadModelFile(f, file, { fetch: fetcher, signal: ctl.signal, onProgress: (n) => { d.loaded = base + n; } });
        } else writeFileSync(file + ".sha256", f.sha256);
        before += f.size;
        d.loaded = before;
      }
    })().then(
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
    for (const f of this.spec.files) {
      const file = this.fileOf(f);
      for (const x of [file, file + ".sha256", file + ".part"]) rmSync(x, { force: true });
    }
    this.installed = false;
    this.lastError = undefined;
  }
}

/**
 * Elija 17.11.: mehrere Modelle zur Auswahl (Katalog: base, small, large-v3-turbo). Eines ist gewählt (Vermerk in
 * `<ordner>/transcription.json`, Standard small); transkribiert wird mit dem gewählten, wenn es geladen ist, sonst mit
 * einem anderen geladenen (wer früher base geladen hat, verliert nichts).
 */
class ServerModels {
  readonly models: ServerModel[];
  private active: string;
  private readonly note: string;

  constructor(dir: string, cfg: WhisperConfig, log: Logger) {
    const specs = cfg.specs ?? (cfg.spec ? [cfg.spec] : localModels.catalogAll("transcription"));
    this.models = specs.map((s) => new ServerModel(s, dir, cfg, log));
    this.note = join(dir, "transcription.json");
    let saved: unknown;
    try { saved = (JSON.parse(readFileSync(this.note, "utf8")) as { active?: unknown }).active; } catch { /* noch nichts gewählt */ }
    const known = (id: unknown): id is string => typeof id === "string" && specs.some((s) => s.id === id);
    this.active = known(saved) ? saved : known(localModels.DEFAULT_TRANSCRIPTION_MODEL) ? localModels.DEFAULT_TRANSCRIPTION_MODEL : specs[0]!.id;
  }

  get(id: unknown): ServerModel | undefined { return this.models.find((m) => m.spec.id === (id ?? this.active)); }

  select(id: string) {
    this.active = id;
    mkdirSync(dirname(this.note), { recursive: true });
    writeFileSync(this.note, JSON.stringify({ active: id }));
  }

  /** Datei des gewählten Modells; ist es nicht geladen, die eines anderen geladenen. */
  async path(): Promise<string | undefined> {
    const chosen = await this.get(undefined)?.path();
    if (chosen) return chosen;
    for (const m of this.models) { const p = await m.path(); if (p) return p; }
    return undefined;
  }

  async state() {
    const all = await Promise.all(this.models.map(async (m) => ({ ...(await m.state()), active: m.spec.id === this.active })));
    return { active: all.find((m) => m.active)!, all };
  }
}

export function registerTranscribeRoutes(router: Router, cfg: WhisperConfig, log: Logger) {
  let queue: Promise<unknown> = Promise.resolve();
  const catalog = !cfg.model && cfg.modelsDir ? new ServerModels(cfg.modelsDir, cfg, log) : undefined;
  const modelPath = async () => (cfg.model ? (existsSync(cfg.model) ? cfg.model : undefined) : await catalog?.path());
  const binPath = () => (cfg.bin && existsSync(cfg.bin) ? cfg.bin : cfg.find?.());
  router.add("GET", "/local/transcribe", async () => {
    const models = await catalog?.state();
    return json({
      engine: "whisper.cpp",
      // Feedback 17. 11.: getrennt melden, was fehlt – das Programm oder das Modell (Einstellungen → Meeting notes).
      engineInstalled: binPath() !== undefined,
      ready: binPath() !== undefined && (await modelPath()) !== undefined,
      // `model`: das gewählte (wie bisher); `models`: alle zur Auswahl, `active` markiert das gewählte.
      model: cfg.model ? { source: "file", installed: existsSync(cfg.model) } : models ? { source: "catalog", ...models.active } : { source: "none", installed: false },
      ...(models ? { models: models.all } : {}),
    });
  });
  // Teil 3d: Modell aus dem Katalog laden lassen (nur Besitzer, nur auf ausdrücklichen Aufruf). `id` wählt das Modell
  // (ohne: das gewählte); „download“ und „select“ machen es zum gewählten.
  router.add("POST", "/local/transcribe/model", async ({ body }) => {
    if (!catalog) return error(cfg.model ? "the server uses its own model file (BASED_WHISPER_MODEL)" : "no models folder", 409);
    let action: unknown, id: unknown;
    try { ({ action, id } = JSON.parse(new TextDecoder().decode(body)) as { action?: unknown; id?: unknown }); } catch { return error("JSON body {action, id?}", 400); }
    const model = catalog.get(id);
    if (!model) return error("unknown model", 404);
    if (action === "download") { catalog.select(model.spec.id); model.start(); }
    else if (action === "select") catalog.select(model.spec.id);
    else if (action === "cancel") model.cancel();
    else if (action === "remove") await model.remove();
    else return error("action must be download, select, cancel or remove", 400);
    return json({ ...(await model.state()), models: (await catalog.state()).all }, action === "download" ? 202 : 200);
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
