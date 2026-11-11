#!/usr/bin/env node
// BSD-138: bündelt sidecar/entry.ts (lokaler Server + Kommandozeile `based`) mit esbuild zu einer Datei
// dist-sidecar/based-server.cjs (ein paar MB). Sie liegt der App als Resource bei (tauri.conf.json →
// bundle.resources) und läuft mit der Node des Nutzers (≥ 22) – keine gebündelte Node-Laufzeit, kein Signieren.
// Läuft auf jedem Rechner (auch Linux):  node scripts/build-sidecar.mjs
// Build-Abhängigkeit: esbuild (MIT).
import { mkdirSync } from "node:fs";
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
});
console.log(`bundled ${file}`);
