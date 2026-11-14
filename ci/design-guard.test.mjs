// BSD-412: Der Design-Wächter entfernt Kommentare mit dem TypeScript-Parser – ein „/*“ in Strings, Regex oder
// JSX-Attributen öffnet keinen Kommentar mehr. Läuft in ci/typecheck/run-ts.sh (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTSComments } from "./design-guard.mjs";

const count = (src, file = "x.tsx") => (stripTSComments(src, file).match(/<button\b/g) ?? []).length;

test("„/*“ in einem Attribut, String oder Regex verschluckt keine Buttons", () => {
  const src = `export const A = () => (<>
    <input type="file" accept="image/*" />
    <button type="button">One</button>
    {/** kein <button> hier */}
    <button type="button">Two</button>
  </>);
  const glob = "src/**/*.ts"; const re = /a\\/*b/;
  // <button> im Zeilenkommentar
  export const B = () => <button type="button">Three</button>; /* <button> */`;
  assert.equal(count(src), 3);
});

test("Apostroph im JSX-Text stört nicht; .ts-Dateien ohne JSX", () => {
  assert.equal(count(`export const C = () => <p>Don't <button type="button">x</button></p>;`), 1);
  assert.equal(count(`const s = "<button"; // <button\\n`, "x.ts"), 1);
});
