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

// BSD-541: ONNX-Laufzeit für die Suche nach Bedeutung (`recall` über MCP) neben das Bundle legen – onnxruntime-web
// (MIT), nur die Node-Variante mit ihrer WebAssembly-Datei (~12 MB, keine native Datei, also nichts zu signieren).
// Der Server lädt sie per require relativ zu based-server.cjs; fehlt sie, bleibt recall bei Wörtern und Nachbarn.
try {
  const serverReq = createRequire(join(desktop, "..", "server", "package.json"));
  const webSrc = join(dirname(serverReq.resolve("onnxruntime-web")), "..");
  const commonSrc = join(dirname(createRequire(join(webSrc, "package.json")).resolve("onnxruntime-common")), "..", "..");
  const webOut = join(out, "node_modules", "onnxruntime-web"), commonOut = join(out, "node_modules", "onnxruntime-common");
  rmSync(webOut, { recursive: true, force: true });
  rmSync(commonOut, { recursive: true, force: true });
  mkdirSync(join(webOut, "dist"), { recursive: true });
  mkdirSync(commonOut, { recursive: true });
  cpSync(join(webSrc, "package.json"), join(webOut, "package.json"));
  for (const f of ["ort.node.min.js", "ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) cpSync(join(webSrc, "dist", f), join(webOut, "dist", f));
  cpSync(join(commonSrc, "package.json"), join(commonOut, "package.json"));
  cpSync(join(commonSrc, "dist", "cjs"), join(commonOut, "dist", "cjs"), { recursive: true });
  console.log(`copied onnxruntime-web → ${webOut}`);
} catch (e) {
  console.log(`onnxruntime-web not bundled (${e instanceof Error ? e.message : String(e)}) – recall works without search by meaning`);
}
