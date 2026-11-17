#!/usr/bin/env node
// BSD-452: Prüfschritt für den DMG-Build – liegt die Node für alle Mac-Architekturen in der App?
//   node scripts/check-node.mjs <Based Beta.app | …/node/bin/node> [--expect arm64,x86_64]
// Liest die Mach-O-Köpfe selbst (scripts/macho.mjs, läuft auch unter Linux); auf dem Mac zusätzlich `lipo -info`
// zum Vergleich. Exit 1, wenn eine erwartete Architektur fehlt oder eine Slice kaputt ist. Ohne --expect:
// arm64 und x86_64 (Universal-Build).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fatArchs } from "./macho.mjs";

/** Pfad der Node in einem .app-Bundle (Resource node/bin/node) oder die Datei selbst. */
export function nodePath(target) {
  if (existsSync(target) && statSync(target).isDirectory()) return join(target, "Contents", "Resources", "node", "bin", "node");
  return target;
}

/** Ergebnis für eine Node-Datei: gefundene Architekturen und was fehlt. */
export function checkNode(buf, expect = ["arm64", "x86_64"]) {
  const archs = fatArchs(buf);
  const names = archs.filter((a) => a.valid).map((a) => a.name);
  const broken = archs.filter((a) => !a.valid).map((a) => a.name);
  const missing = expect.filter((e) => !names.includes(e));
  return { ok: missing.length === 0 && broken.length === 0, archs: names, missing, broken };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--expect");
  const expect = i >= 0 ? (args.splice(i, 2)[1] ?? "").split(",").filter(Boolean) : ["arm64", "x86_64"];
  const file = nodePath(args[0] ?? "");
  if (!args[0] || !existsSync(file)) {
    console.error(`check-node: ${file || "(no path)"} not found – the app would fall back to the user's Node.js`);
    process.exit(1);
  }
  const r = checkNode(readFileSync(file), expect);
  console.log(`check-node: ${file}: ${r.archs.join(" + ") || "no Mach-O"}${r.missing.length ? ` – missing ${r.missing.join(", ")}` : ""}${r.broken.length ? ` – broken ${r.broken.join(", ")}` : ""}`);
  if (process.platform === "darwin") {
    try { console.log(`lipo: ${execFileSync("lipo", ["-info", file], { encoding: "utf8" }).trim()}`); } catch { /* ohne Xcode-Werkzeuge */ }
  }
  process.exit(r.ok ? 0 : 1);
}
