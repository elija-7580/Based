#!/usr/bin/env node
// BSD-231 (Elija 17.11.: „Whisper direkt in der App, ohne Terminal“): whisper.cpp für die Mac-App. Baut das Programm
// `whisper-cli` aus dem gepinnten Quellstand (Tag + Commit geprüft) und legt es mit Lizenz nach dist-sidecar/whisper/
// (Resource `whisper/` in tauri.conf.json). Der lokale Server der App bekommt den Pfad über BASED_WHISPER_BUNDLED und
// transkribiert Meeting-Aufnahmen damit auf dem Gerät; das Sprachmodell lädt der Nutzer erst per Opt-in.
//
// - Nur macOS (Xcode-Werkzeuge: git, cmake, clang). Statisch gelinkt, Metal eingebettet, kein OpenMP, kein curl/SDL:
//   eine einzelne Datei ohne fremde Bibliotheken (nur System-Frameworks).
// - Ziel: TAURI_ENV_TARGET_TRIPLE wie bei fetch-node.mjs. „universal-apple-darwin“ baut arm64 und x86_64 getrennt
//   (ggml wählt die CPU-Befehle nach CMAKE_OSX_ARCHITECTURES) und fügt sie zu EINER universellen Datei zusammen
//   (scripts/macho.mjs). Alles oder nichts: fehlt eine Architektur, liegt kein Programm bei.
// - Fertige Programme liegen im Cache (Standard src-tauri/target/whisper-cache, vom CI-Cache erfasst).
// - Nie ein Build-Abbruch: ohne Werkzeuge, ohne Netz, bei falschem Commit, Fehler oder Zeitüberschreitung bleibt
//   dist-sidecar/whisper/ ohne Programm (nur README) – die App sucht dann ein installiertes whisper-cli
//   (`brew install whisper-cpp`) und sagt in den Einstellungen, was fehlt. BASED_SKIP_WHISPER=1 überspringt den Bau.
// whisper.cpp ist MIT-lizenziert (LICENSE liegt bei). Signiert wird in sign-node.mjs.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fatArchs, makeFat } from "./macho.mjs";

export const WHISPER_REPO = "https://github.com/ggml-org/whisper.cpp";
export const WHISPER_VERSION = "v1.8.7";
/** Commit, auf den der Tag zeigt – nur dieser Stand wird gebaut. */
export const WHISPER_COMMIT = "48f628a84833905ee4a0658ee6d4a5c915ce1997";
/** Älteste macOS-Version der App (tauri.conf.json → bundle.macOS.minimumSystemVersion). */
export const MACOS_MIN = "13.0";

/** Mac-Architekturen für ein Tauri-Ziel bzw. diesen Rechner; leer = nicht bauen. */
export function whisperArchs({ triple, platform, arch }) {
  if (triple) {
    if (triple === "universal-apple-darwin") return ["arm64", "x86_64"];
    if (triple === "aarch64-apple-darwin") return ["arm64"];
    if (triple === "x86_64-apple-darwin") return ["x86_64"];
    return [];
  }
  if (platform !== "darwin") return [];
  return arch === "arm64" ? ["arm64"] : arch === "x64" ? ["x86_64"] : [];
}

/** cmake-Argumente für eine Architektur (rein, getestet). */
export function cmakeArgs({ src, build, arch }) {
  return [
    "-S", src, "-B", build,
    "-DCMAKE_BUILD_TYPE=Release",
    `-DCMAKE_OSX_ARCHITECTURES=${arch}`,
    `-DCMAKE_OSX_DEPLOYMENT_TARGET=${MACOS_MIN}`,
    "-DBUILD_SHARED_LIBS=OFF",
    "-DWHISPER_BUILD_EXAMPLES=ON", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF",
    "-DWHISPER_SDL2=OFF", "-DWHISPER_CURL=OFF", "-DWHISPER_COREML=OFF",
    // nicht für die CPU des Build-Rechners optimieren: das Programm läuft auf fremden Macs
    "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF",
    "-DGGML_METAL=ON", "-DGGML_METAL_EMBED_LIBRARY=ON",
  ];
}

const README = "BSD-231: Hier liegt whisper-cli (whisper.cpp, MIT) für die Transkription der Meeting-Notizen. Fehlt es, sucht die App ein installiertes whisper-cli.\n";

const defaultRun = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 900_000, maxBuffer: 64 << 20, ...opts });

/** Quellstand holen (flach, nur der Tag) und den Commit prüfen. */
function fetchSource({ dir, run, log }) {
  const head = () => { try { return run("git", ["-C", dir, "rev-parse", "HEAD"]).trim(); } catch { return ""; } };
  if (head() === WHISPER_COMMIT) return true;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  run("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", WHISPER_VERSION, WHISPER_REPO, dir]);
  if (head() !== WHISPER_COMMIT) { log(`whisper: ${WHISPER_VERSION} is not commit ${WHISPER_COMMIT.slice(0, 12)} – not bundled`); return false; }
  return true;
}

/**
 * Baut whisper-cli für `archs` nach `out/whisper-cli` (+ LICENSE). `run(cmd, args)` führt Programme aus (Tests: Doppel).
 * Gibt true zurück, wenn das Programm beiliegt.
 */
export async function buildWhisper({ out, cache, archs, run = defaultRun, log = console.log }) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "README.txt"), README);
  if (archs.length === 0) { log("whisper: not built for this target"); return false; }
  try {
    const src = join(cache, `src-${WHISPER_VERSION}`);
    const binaries = [];
    for (const arch of archs) {
      const cached = join(cache, `${WHISPER_VERSION}-${arch}`, "whisper-cli");
      if (!existsSync(cached)) {
        if (!fetchSource({ dir: src, run, log })) return false;
        const build = join(cache, `build-${WHISPER_VERSION}-${arch}`);
        rmSync(build, { recursive: true, force: true });
        const started = Date.now();
        run("cmake", cmakeArgs({ src, build, arch }));
        run("cmake", ["--build", build, "--target", "whisper-cli", "--config", "Release", "-j", "8"]);
        const built = join(build, "bin", "whisper-cli");
        if (!existsSync(built)) { log(`whisper: build for ${arch} produced no whisper-cli – not bundled`); return false; }
        mkdirSync(dirname(cached), { recursive: true });
        copyFileSync(built, cached);
        copyFileSync(join(src, "LICENSE"), join(dirname(cached), "LICENSE"));
        rmSync(build, { recursive: true, force: true });
        log(`whisper: built ${WHISPER_VERSION} for ${arch} in ${Math.round((Date.now() - started) / 1000)} s`);
      }
      binaries.push(cached);
    }
    const target = join(out, "whisper-cli");
    if (binaries.length === 1) copyFileSync(binaries[0], target);
    else {
      const fat = makeFat(binaries.map((b) => readFileSync(b)));
      writeFileSync(target, fat);
      log(`whisper: universal binary ${fatArchs(fat).map((a) => a.name).join(" + ")} (${(fat.length / 1e6).toFixed(1)} MB)`);
    }
    chmodSync(target, 0o755);
    copyFileSync(join(dirname(binaries[0]), "LICENSE"), join(out, "LICENSE"));
    log(`whisper: bundled ${WHISPER_VERSION} (${archs.join(" + ")}) → ${target}`);
    return true;
  } catch (e) {
    const text = e instanceof Error ? `${e.message}\n${e.stderr ?? ""}` : String(e);
    log(`whisper: build failed (${text.trim().split("\n").slice(-3).join(" | ").slice(0, 600)}) – the app looks for an installed whisper-cli instead`);
    rmSync(join(out, "whisper-cli"), { force: true });
    return false;
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out = join(desktop, "dist-sidecar", "whisper");
  const archs = process.env.BASED_SKIP_WHISPER === "1" ? [] : whisperArchs({ triple: process.env.TAURI_ENV_TARGET_TRIPLE, platform: process.platform, arch: process.arch });
  await buildWhisper({ out, cache: process.env.BASED_WHISPER_CACHE || join(desktop, "src-tauri", "target", "whisper-cache"), archs });
}
