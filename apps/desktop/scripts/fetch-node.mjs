#!/usr/bin/env node
// BSD-414: eigene Node-Laufzeit für den lokalen Server der Mac-App (Backups, iCloud-Sync, MCP, CLI ohne installiertes
// Node). Lädt die gepinnte offizielle Node-Version von nodejs.org, prüft die SHA-256-Summe und legt nur `bin/node`
// und die Lizenz nach dist-sidecar/node/ (Resource `node/` in tauri.conf.json). Läuft im Sidecar-Schritt vor jedem
// Build (beforeBuildCommand/beforeDevCommand); das Archiv wird in .cache/ wiederverwendet.
//
// Ziel: TAURI_ENV_TARGET_TRIPLE (von `tauri build --target …`), sonst Plattform/Architektur dieses Rechners.
// BSD-452 (Elija 16.11.: Beta für Apple Silicon und Intel): Bei „universal-apple-darwin“ werden arm64- und x64-Node
// geladen, beide geprüft und zu EINER universellen Datei bin/node zusammengefügt (scripts/macho.mjs, wie
// `lipo -create`; ≈ 2 × 40 MB unkomprimiert, im DMG ≈ +40 MB gegenüber nur arm64). macOS startet die passende Slice
// selbst – derselbe Pfad, keine Auswahl zur Laufzeit. Fehlt eine der beiden (Netz, Prüfsumme), liegt keine Node bei
// und die App nimmt die des Nutzers (Hinweis in den Einstellungen). Ein eigener x86_64-Build bekommt nur die x64-Node.
//
// Nie ein Build-Abbruch: ohne Netz, mit falscher Prüfsumme, auf anderen Plattformen oder mit BASED_SKIP_NODE=1 bleibt
// dist-sidecar/node/ ohne Laufzeit (nur README) und die App sucht Node wie bisher in der Login-Shell.
// Node.js ist MIT-lizenziert (LICENSE liegt bei). Keine Signatur hier – das macht der Desktop-Workflow (BSD-272).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fatArchs, makeFat } from "./macho.mjs";

export const NODE_VERSION = "v24.22.2";
/** SHA-256 der offiziellen Archive (https://nodejs.org/dist/v24.22.2/SHASUMS256.txt). */
export const NODE_SHA256 = {
  "darwin-arm64": "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a",
  "darwin-x64": "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52",
  "linux-x64": "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9",
};

/** BSD-452: Node-Archive für ein Tauri-Ziel; universal = beide Mac-Architekturen (eine universelle Datei). */
export function nodeTargets({ triple, platform, arch }) {
  if (triple === "universal-apple-darwin") return ["darwin-arm64", "darwin-x64"];
  const one = nodeTarget({ triple, platform, arch });
  return one ? [one] : [];
}

/** Node-Archiv für ein einfaches Tauri-Ziel bzw. diesen Rechner; `undefined` = keine Laufzeit mitliefern. */
export function nodeTarget({ triple, platform, arch }) {
  if (triple) {
    if (triple === "aarch64-apple-darwin") return "darwin-arm64";
    if (triple === "x86_64-apple-darwin") return "darwin-x64";
    if (triple === "x86_64-unknown-linux-gnu") return "linux-x64";
    return undefined;
  }
  const key = `${platform}-${arch}`;
  return key in NODE_SHA256 ? key : undefined;
}

export const archiveName = (target) => `node-${NODE_VERSION}-${target}.tar.gz`;
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Archiv prüfen: nur die gepinnte Summe zählt. */
export function verifyArchive(target, data) {
  const want = NODE_SHA256[target];
  return want !== undefined && sha256(data) === want;
}

const README = "BSD-414: Hier liegt die mitgelieferte Node-Laufzeit (bin/node, LICENSE). Fehlt sie, nimmt die App die Node aus der Login-Shell.\n";

/** Archiv aus dem Cache oder von nodejs.org; nur mit passender Prüfsumme. */
async function loadArchive({ cache, target, fetcher, log }) {
  mkdirSync(cache, { recursive: true });
  const file = join(cache, archiveName(target));
  let data = existsSync(file) ? readFileSync(file) : undefined;
  if (!data || !verifyArchive(target, data)) {
    try {
      const res = await fetcher(`https://nodejs.org/dist/${NODE_VERSION}/${archiveName(target)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      log(`node: download failed (${e instanceof Error ? e.message : String(e)}) – the app falls back to the user's Node`);
      return undefined;
    }
    if (!verifyArchive(target, data)) { log(`node: checksum mismatch (${target}) – not bundled`); return undefined; }
    writeFileSync(file + ".tmp", data);
    renameSync(file + ".tmp", file);
  }
  return file;
}

/**
 * Lädt die Node für `target` (ein Archiv) bzw. `targets` (mehrere Mac-Architekturen → eine universelle Datei) nach
 * `out/bin/node` (+ LICENSE). Alles oder nichts: fehlt eine Architektur, liegt keine Node bei.
 */
export async function fetchNode({ out, cache, target, targets = target ? [target] : [], fetcher = fetch, log = console.log }) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "README.txt"), README);
  if (targets.length === 0) { log("node: no bundled runtime for this target"); return false; }
  const files = [];
  for (const t of targets) {
    const file = await loadArchive({ cache, target: t, fetcher, log });
    if (!file) return false;
    files.push([t, file]);
  }
  const tmp = join(out, ".extract");
  mkdirSync(tmp, { recursive: true });
  const binaries = [];
  for (const [t, file] of files) {
    const top = `node-${NODE_VERSION}-${t}`;
    execFileSync("tar", ["-xzf", file, "-C", tmp, `${top}/bin/node`, `${top}/LICENSE`]);
    binaries.push(join(tmp, top, "bin", "node"));
  }
  mkdirSync(join(out, "bin"), { recursive: true });
  const node = join(out, "bin", "node");
  if (binaries.length === 1) renameSync(binaries[0], node);
  else {
    const fat = makeFat(binaries.map((b) => readFileSync(b)));
    writeFileSync(node, fat);
    log(`node: universal binary ${fatArchs(fat).map((a) => a.name).join(" + ")} (${Math.round(fat.length / 1e6)} MB)`);
  }
  renameSync(join(tmp, `node-${NODE_VERSION}-${files[0][0]}`, "LICENSE"), join(out, "LICENSE"));
  rmSync(tmp, { recursive: true, force: true });
  chmodSync(node, 0o755);
  log(`node: bundled ${NODE_VERSION} (${targets.join(" + ")}) → ${node}`);
  return true;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out = join(desktop, "dist-sidecar", "node");
  const targets = process.env.BASED_SKIP_NODE === "1" ? [] : nodeTargets({ triple: process.env.TAURI_ENV_TARGET_TRIPLE, platform: process.platform, arch: process.arch });
  await fetchNode({ out, cache: join(desktop, ".cache", "node"), targets });
}
