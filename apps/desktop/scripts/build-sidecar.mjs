#!/usr/bin/env node
// BSD-138: bündelt sidecar/entry.ts (lokaler Server + Kommandozeile `based`) mit esbuild zu einer Datei
// dist-sidecar/based-server.cjs (ein paar MB). Sie liegt der App als Resource bei (tauri.conf.json →
// bundle.resources) und läuft mit der Node des Nutzers (≥ 22) – keine gebündelte Node-Laufzeit, kein Signieren.
// Läuft auf jedem Rechner (auch Linux):  node scripts/build-sidecar.mjs
// Build-Abhängigkeit: esbuild (MIT).
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(desktop, "dist-sidecar");
mkdirSync(out, { recursive: true });
const file = join(out, "based-server.cjs");
await build({
  entryPoints: [join(desktop, "sidecar", "entry.ts")],
  outfile: file,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // `import.meta.url` (createRequire für node:sqlite) zeigt auf die Datei selbst; main.ts startet nicht doppelt.
  define: { "import.meta.url": "__based_meta_url", __BASED_BUNDLED__: "true" },
  banner: { js: "const __based_meta_url = require(\"node:url\").pathToFileURL(__filename).href;" },
  minify: true,
  keepNames: true,
  logLevel: "warning",
  legalComments: "linked",
  // BSD-314: node-pty (MIT) hat eine native Datei – nicht ins Bundle, sondern daneben (node_modules/…, Resource).
  external: ["@homebridge/node-pty-prebuilt-multiarch"],
});
console.log(`bundled ${file}`);

// BSD-314: node-pty für das Terminal neben das Bundle legen (nur lib/ und die fertigen Binärdateien für macOS und
// Linux; node-addon-api braucht es nur beim Bauen). Der Server lädt es per require relativ zu based-server.cjs.
const PTY = "@homebridge/node-pty-prebuilt-multiarch";
const ptySrc = dirname(createRequire(join(desktop, "..", "server", "package.json")).resolve(`${PTY}/package.json`));
const ptyOut = join(out, "node_modules", ...PTY.split("/"));
rmSync(ptyOut, { recursive: true, force: true });
mkdirSync(ptyOut, { recursive: true });
for (const f of ["package.json", "LICENSE", "lib"]) cpSync(join(ptySrc, f), join(ptyOut, f), { recursive: true });
for (const p of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]) cpSync(join(ptySrc, "prebuilds", p), join(ptyOut, "prebuilds", p), { recursive: true });
console.log(`copied ${PTY} → ${ptyOut}`);
