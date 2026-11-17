// Update-Notizen: Interna fallen weg, Präfixe werden entfernt, die Kurzfassung passt in den Dialog alter Versionen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { notesFrom } from "./release-notes.mjs";

const subjects = [
  "Sign-node: codesign bei ausbleibendem Zeitstempel wiederholen (bis zu fünf Versuche)",
  "Desktop-Build: laufenden Build nicht mehr durch den nächsten Push abbrechen",
  "BSD-267/265/269: echte Links zwischen Seitenkarten, Snap shapes, Present, Textvorschau rollen",
  "ADR 0017 Stufe B: Gliederung, Titel, Papierkorb, Backlinks und unverlinkte Erwähnungen ohne den ganzen Store",
  "Based Notes as the official name, legal pages in English",
  "Logo-Intro: das Zeichen tippt sich beim ersten Start",
];

test("Interna fallen weg, Präfixe (auch mehrere IDs, ADR-Stufen) werden entfernt", () => {
  const out = notesFrom(subjects).split("\n");
  assert.equal(out.some((l) => /sign-node|desktop-build/i.test(l)), false);
  assert.equal(out[0], "• Echte Links zwischen Seitenkarten, Snap shapes, Present, Textvorschau rollen");
  assert.match(out[1], /^• Gliederung, Titel/);
});

test("Kurzfassung: höchstens 3 Zeilen, je höchstens 80 Zeichen (plus Punkt)", () => {
  const out = notesFrom(subjects, 3, 80).split("\n");
  assert.equal(out.length, 3);
  for (const l of out) assert.ok(l.length <= 82, l);
});

test("nichts Brauchbares: ein Standardsatz", () => {
  assert.equal(notesFrom(["Sign-node: x", "Merge branch 'a'"]), "• Small fixes and improvements");
});
