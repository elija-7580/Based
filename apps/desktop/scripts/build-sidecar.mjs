#!/usr/bin/env node
// BSD-138: baut die Beilage der Desktop-App als eine ausführbare Datei (Node „Single Executable Application“):
//   based-server --local   lokaler Server (Sidecar), damit CLI und Coding-Agenten ohne eigenen Server laufen
//   based-server cli …     die Kommandozeile `based` (eine Node-Laufzeit für beides, sidecar/entry.ts)
// Ablage nach Tauri-Konvention: src-tauri/binaries/<name>-<target-triple> (tauri.conf.json → bundle.externalBin).
// Keine eigene Rust-Logik (ADR 0011): Start/Stopp macht das Shell-Plugin vom Web-Frontend aus (apps/web/src/desktop.ts).
//
//   node scripts/build-sidecar.mjs            bündeln + SEA für diesen Rechner
//   node scripts/build-sidecar.mjs --bundle   nur bündeln (dist-sidecar/based-server.cjs, läuft mit `node`)
// Abhängigkeiten (Build-Zeit): esbuild (MIT), postject (MIT); zur Laufzeit nichts, Node steckt in der Datei.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const out = join(desktop, "dist-sidecar");
const binaries = join(desktop, "src-tauri", "binaries");
const bundleOnly = process.argv.includes("--bundle");

/** Ziel-Tripel wie Tauri es erwartet (`rustc -vV` → host), sonst aus Node abgeleitet. */
export function targetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  try {
    const host = /host: (\S+)/.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))?.[1];
    if (host) return host;
  } catch {
    // kein Rust auf diesem Rechner
  }
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  if (process.platform === "win32") return `${arch}-pc-windows-msvc`;
  return `${arch}-unknown-linux-gnu`;
}

const ENTRIES = [{ name: "based-server", entry: join(desktop, "sidecar", "entry.ts") }];

async function bundle(name, entry) {
  const file = join(out, `${name}.cjs`);
  await build({
    entryPoints: [entry],
    outfile: file,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    // SEA kennt nur CommonJS; `import.meta.url` (createRequire für node:sqlite) zeigt auf die Datei selbst.
    define: { "import.meta.url": "__based_meta_url", __BASED_BUNDLED__: "true" },
    banner: { js: "const __based_meta_url = require(\"node:url\").pathToFileURL(__filename).href;" },
    logLevel: "warning",
    legalComments: "linked",
  });
  return file;
}

function sea(name, script) {
  const blob = join(out, `${name}.blob`);
  const config = join(out, `${name}.sea.json`);
  writeFileSync(config, JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false }));
  execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
  const triple = targetTriple();
  const exe = join(binaries, `${name}-${triple}${process.platform === "win32" ? ".exe" : ""}`);
  mkdirSync(binaries, { recursive: true });
  rmSync(exe, { force: true });
  copyFileSync(process.execPath, exe);
  chmodSync(exe, 0o755);
  if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", exe], { stdio: "inherit" });
  const postject = join(desktop, "node_modules", ".bin", process.platform === "win32" ? "postject.cmd" : "postject");
  const args = [exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"];
  if (process.platform === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  execFileSync(postject, args, { stdio: "inherit", shell: process.platform === "win32" });
  // Ad-hoc-Signatur (wie die App selbst, `signingIdentity: "-"`); echte Signatur beim Release.
  if (process.platform === "darwin") execFileSync("codesign", ["--sign", "-", exe], { stdio: "inherit" });
  return exe;
}

mkdirSync(out, { recursive: true });
for (const { name, entry } of ENTRIES) {
  const script = await bundle(name, entry);
  if (bundleOnly) {
    console.log(`bundled ${script}`);
    continue;
  }
  console.log(`built ${sea(name, script)}`);
}
