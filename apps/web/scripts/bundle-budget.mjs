// BSD-280: Budget für das Start-Bundle. Nach `vite build` aufrufen: misst das Einstiegs-Skript (index-*.js) und das
// Einstiegs-CSS gzip-komprimiert und schlägt fehl, wenn sie größer werden als erlaubt. Grenzen mit Luft über dem Stand
// vom 11.11.2026 (JS 1 120 kB, CSS 87 kB gzip); wer sie anhebt, schreibt den Grund in den Commit.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const BUDGET_KB = { js: 1200, css: 95 };
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
const lazy = readdirSync(dir).filter((f) => f.endsWith(".js") && !f.startsWith("index-")).length;
console.log(`${lazy} lazily loaded chunks`);
process.exit(failed ? 1 : 0);
