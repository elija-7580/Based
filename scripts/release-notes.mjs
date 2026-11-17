#!/usr/bin/env node
// BSD-168: Update-Notizen für Based Next aus den Commits seit dem letzten Release (next-<version>).
//   node scripts/release-notes.mjs [<vorheriger-ref>]   → Markdown-Liste auf stdout (leer: „Kleine Verbesserungen“)
// Ohne Ref: das neueste Tag next-<x.y.z>. Merges, Nachtlauf-Buchhaltung und reine Doku/Screenshot-Commits fallen weg;
// Präfixe wie „BSD-123 Teil 2:“ oder „TS ·“ werden entfernt. Höchstens 12 Punkte, je höchstens 110 Zeichen.
//   --short: höchstens 3 Punkte, je höchstens 80 Zeichen – für latest.json. Der Update-Dialog älterer Versionen
//   (bis 0.1.163) scrollt nicht; mit zwölf Zeilen lag „Install and Restart“ außerhalb des Fensters (17.11.).
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

export function notesFrom(subjects, max = 12, width = 110) {
  // Interna (Build, Signieren, CI, Architektur-Stufen) gehören nicht in die Notizen für Nutzer.
  const skip = /^(merge\b|nachtlauf\b|pass \d|screenshots?\b|ci\b|doku\b|docs?:|replica\b|backlog\b|build-log\b|planung\b|sign-node\b|desktop-build\b|board-e2e\b|e2e\b|cla\b|lizenz\b)/i;
  const seen = new Set();
  const out = [];
  for (const raw of subjects) {
    let s = raw.trim();
    if (!s || skip.test(s)) continue;
    s = s.replace(/^(BSD-\d+(?:\/\d+)*(\s+(Teil|Nachtrag)\s*[\w.]*)?|ADR\s+\d+(\s+Stufe\s+\w+)?|Fix|Feinschliff)\s*[:·–-]\s*/i, "").replace(/^TS\s*·\s*/, "").trim();
    if (!s || skip.test(s)) continue;
    s = s[0].toUpperCase() + s.slice(1);
    if (s.length > width) s = s.slice(0, width - 3).replace(/\s+\S*$/, "") + " …";
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push("• " + s);
    if (out.length === max) break;
  }
  return out.length ? out.join("\n") : "• Small fixes and improvements";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const short = process.argv.includes("--short");
  let prev = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!prev) {
    const tags = git("tag", "-l", "next-*", "--sort=-version:refname").split("\n").filter((t) => /^next-\d+\.\d+\.\d+$/.test(t));
    prev = tags[0];
  }
  const range = prev ? `${prev}..HEAD` : "HEAD~20..HEAD";
  const subjects = git("log", "--no-merges", "--format=%s", range).split("\n");
  process.stdout.write((short ? notesFrom(subjects, 3, 80) : notesFrom(subjects)) + "\n");
}
