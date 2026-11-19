// BSD-280: Budget für das Start-Bundle. Nach `vite build` aufrufen: misst das Einstiegs-Skript (index-*.js) und das
// Einstiegs-CSS gzip-komprimiert und schlägt fehl, wenn sie größer werden als erlaubt. Grenzen mit Luft über dem Stand
// vom 11.11.2026 (JS 1 120 kB, CSS 87 kB gzip); wer sie anhebt, schreibt den Grund in den Commit.
// BSD-595 (19.11.2026): Chat, Agenten und Anbieter sind eigene Chunks – Start-JS 1 063 → 918 kB, Store-Worker
// 319 → 281 kB gzip (je KiB wie unten). Grenzen auf den neuen Stand + 5 %; der Store-Worker wird jetzt mitgemessen.
// Review 19.11.2026: Küstenlinien der Karte als eigener Chunk – Start-JS 918 → 893 kB; JS-Grenze 965 → 940 kB.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const BUDGET_KB = { js: 940, css: 95, worker: 295 };
const dir = new URL("../dist/assets/", import.meta.url).pathname;
const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const entry = (ext) => {
  const m = new RegExp(`assets/(index-[^"]+\\.${ext})`).exec(html);
  if (!m) throw new Error(`no entry .${ext} in dist/index.html`);
  return m[1];
};
let failed = false;
for (const ext of ["js", "css"]) {
  const file = entry(ext);
  const kb = gzipSync(readFileSync(join(dir, file))).length / 1024;
  const ok = kb <= BUDGET_KB[ext];
  console.log(`${ok ? "ok  " : "OVER"} ${file}: ${kb.toFixed(0)} kB gzip (budget ${BUDGET_KB[ext]} kB)`);
  if (!ok) failed = true;
}
{
  const file = readdirSync(dir).find((f) => /^store\.worker-.*\.js$/.test(f));
  if (!file) throw new Error("no store.worker-*.js in dist/assets");
  const kb = gzipSync(readFileSync(join(dir, file))).length / 1024;
  const ok = kb <= BUDGET_KB.worker;
  console.log(`${ok ? "ok  " : "OVER"} ${file}: ${kb.toFixed(0)} kB gzip (budget ${BUDGET_KB.worker} kB)`);
  if (!ok) failed = true;
}
const lazy = readdirSync(dir).filter((f) => f.endsWith(".js") && !f.startsWith("index-")).length;
console.log(`${lazy} lazily loaded chunks`);
process.exit(failed ? 1 : 0);
