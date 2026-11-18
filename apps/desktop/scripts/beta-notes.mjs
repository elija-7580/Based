// BSD-542: Notizen der Beta aus docs/beta/RELEASE_NOTES.md – der oberste Abschnitt für den GitHub-Release, eine
// Kurzfassung (höchstens 3 Punkte à 80 Zeichen) für latest.json. Der Update-Dialog der installierten Beta 0.2.2–0.2.4
// scrollt noch nicht (df2b1b1d kam danach); mit vielen langen Zeilen läge „Install and Restart“ außerhalb des Fensters
// (Elija 17.11., wie Based Next mit scripts/release-notes.mjs --short).
//   node apps/desktop/scripts/beta-notes.mjs docs/beta/RELEASE_NOTES.md [--short]
import { readFileSync } from "node:fs";

/** Punkte des obersten Abschnitts (`## …`) ohne Überschrift und Leerzeilen. */
export function topSection(markdown) {
  let n = 0;
  return markdown.split("\n").filter((l) => {
    if (/^## /.test(l)) { n += 1; return false; }
    return n === 1;
  }).filter((l) => l.trim() !== "");
}

/** Kurzfassung für latest.json: die ersten `max` Punkte, je höchstens `width` Zeichen (an einer Wortgrenze, „…“). */
export function shortNotes(markdown, max = 3, width = 80) {
  const out = [];
  for (const line of topSection(markdown)) {
    let s = line.replace(/^[-•*]\s+/, "").trim();
    if (!s) continue;
    if ([...s].length > width) s = [...s].slice(0, width - 2).join("").replace(/\s+\S*$/, "") + " …";
    out.push("• " + s);
    if (out.length === max) break;
  }
  return out.length ? out.join("\n") : "• Small fixes and improvements";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) {
    process.stderr.write("usage: beta-notes.mjs <RELEASE_NOTES.md> [--short]\n");
    process.exit(2);
  }
  const md = readFileSync(file, "utf8");
  process.stdout.write((process.argv.includes("--short") ? shortNotes(md) : topSection(md).join("\n")) + "\n");
}
