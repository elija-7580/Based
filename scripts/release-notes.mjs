#!/usr/bin/env node
// BSD-168: Update-Notizen für Based Next aus den Commits seit dem letzten Release (next-<version>).
//   node scripts/release-notes.mjs [<vorheriger-ref>]   → Markdown-Liste auf stdout (leer: „Kleine Verbesserungen“)
// Ohne Ref: das neueste Tag next-<x.y.z>. Merges, Nachtlauf-Buchhaltung und reine Doku/Screenshot-Commits fallen weg;
// Präfixe wie „BSD-123 Teil 2:“ oder „TS ·“ werden entfernt. Höchstens 12 Punkte, je höchstens 110 Zeichen.
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

export function notesFrom(subjects, max = 12) {
  const skip = /^(merge\b|nachtlauf\b|pass \d|screenshots?\b|ci:|doku\b|docs?:|replica\b|backlog\b|build-log\b|planung\b)/i;
  const seen = new Set();
  const out = [];
  for (const raw of subjects) {
    let s = raw.trim();
    if (!s || skip.test(s)) continue;
    s = s.replace(/^(BSD-\d+(\s+Teil\s+[\w.]+)?|Fix|Feinschliff)\s*[:·–-]\s*/i, "").replace(/^TS\s*·\s*/, "").trim();
    if (!s || skip.test(s)) continue;
    s = s[0].toUpperCase() + s.slice(1);
    if (s.length > 110) s = s.slice(0, 107).replace(/\s+\S*$/, "") + " …";
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push("• " + s);
    if (out.length === max) break;
  }
  return out.length ? out.join("\n") : "• Small fixes and improvements";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let prev = process.argv[2];
  if (!prev) {
    const tags = git("tag", "-l", "next-*", "--sort=-version:refname").split("\n").filter((t) => /^next-\d+\.\d+\.\d+$/.test(t));
    prev = tags[0];
  }
  const range = prev ? `${prev}..HEAD` : "HEAD~20..HEAD";
  const subjects = git("log", "--no-merges", "--format=%s", range).split("\n");
  process.stdout.write(notesFrom(subjects) + "\n");
}
