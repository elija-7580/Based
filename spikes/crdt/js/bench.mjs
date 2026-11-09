// BSD-29 Spike: zwei Replikate bearbeiten parallel denselben Absatz, dann Merge.
// Aufruf: npm install && node bench.mjs   (nicht Teil von CI)
import * as A from "@automerge/automerge";
import { LoroDoc } from "loro-crdt";
import * as Y from "yjs";

const BASE = "Der schnelle braune Fuchs springt über den faulen Hund.";
const N = 500; // Ops pro Replikat → 1000 Ops gesamt
const now = () => performance.now();
const ms = (t) => (now() - t).toFixed(1) + " ms";

function typing(n, seed) { // deterministischer „Tipp“-Text
  let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(97 + ((i * 7 + seed) % 26)); return s;
}
const tA = typing(N, 1), tB = typing(N, 3);

// ---------- Automerge ----------
function automerge() {
  let a = A.from({ text: BASE });
  let b = A.clone(a, { actor: "bb".repeat(16) });
  const t0 = now();
  for (let i = 0; i < N; i++) a = A.change(a, (d) => A.splice(d, ["text"], 10 + i, 0, tA[i]));
  for (let i = 0; i < N; i++) b = A.change(b, (d) => A.splice(d, ["text"], BASE.length + i, 0, tB[i]));
  b = A.change(b, (d) => { A.mark(d, ["text"], { start: 0, end: 9, expand: "after" }, "bold", true);
                           A.mark(d, ["text"], { start: 20, end: 30, expand: "none" }, "link", "https://example.com"); });
  const edit = ms(t0);
  const t1 = now();
  const a2 = A.merge(A.clone(a), b), b2 = A.merge(A.clone(b), a);
  const merge = ms(t1);
  const ok = a2.text === b2.text && JSON.stringify(A.marks(a2, ["text"])) === JSON.stringify(A.marks(b2, ["text"]));
  // Interleaving: beide tippen an derselben Stelle
  let x = A.from({ text: "Hallo Welt" }), y = A.clone(x, { actor: "cc".repeat(16) });
  for (const [i, c] of [..."abc"].entries()) x = A.change(x, (d) => A.splice(d, ["text"], 5 + i, 0, c));
  for (const [i, c] of [..."xyz"].entries()) y = A.change(y, (d) => A.splice(d, ["text"], 5 + i, 0, c));
  const inter = A.merge(x, y).text;
  return { lib: "Automerge 3.5.0", edit, merge, converged: ok, chars: a2.text.length,
           snapshot: A.save(a2).length, marks: A.marks(a2, ["text"]).length, interleave: inter };
}

// ---------- Loro ----------
function loro() {
  const mk = (peer) => { const d = new LoroDoc(); d.setPeerId(peer);
    d.configTextStyle({ bold: { expand: "after" }, link: { expand: "none" } }); return d; };
  const a = mk(1n); a.getText("t").insert(0, BASE); a.commit();
  const b = mk(2n); b.import(a.export({ mode: "snapshot" }));
  const t0 = now();
  for (let i = 0; i < N; i++) { a.getText("t").insert(10 + i, tA[i]); a.commit(); }
  for (let i = 0; i < N; i++) { b.getText("t").insert(BASE.length + i, tB[i]); b.commit(); }
  b.getText("t").mark({ start: 0, end: 9 }, "bold", true);
  b.getText("t").mark({ start: 20, end: 30 }, "link", "https://example.com"); b.commit();
  const edit = ms(t0);
  const ua = a.export({ mode: "update", from: b.oplogVersion() });
  const ub = b.export({ mode: "update", from: a.oplogVersion() });
  const t1 = now();
  a.import(ub); b.import(ua);
  const merge = ms(t1);
  const ok = a.getText("t").toString() === b.getText("t").toString() &&
             JSON.stringify(a.getText("t").toDelta()) === JSON.stringify(b.getText("t").toDelta());
  const x = mk(3n); x.getText("t").insert(0, "Hallo Welt"); x.commit();
  const y = mk(4n); y.import(x.export({ mode: "snapshot" }));
  [..."abc"].forEach((c, i) => { x.getText("t").insert(5 + i, c); x.commit(); });
  [..."xyz"].forEach((c, i) => { y.getText("t").insert(5 + i, c); y.commit(); });
  x.import(y.export({ mode: "update", from: x.oplogVersion() }));
  return { lib: "Loro 1.17.1", edit, merge, converged: ok, chars: a.getText("t").length,
           snapshot: a.export({ mode: "snapshot" }).length, marks: a.getText("t").toDelta().filter((d) => d.attributes).length,
           interleave: x.getText("t").toString() };
}

// ---------- Yjs ----------
function yjs() {
  const a = new Y.Doc(); a.clientID = 1; a.getText("t").insert(0, BASE);
  const b = new Y.Doc(); b.clientID = 2; Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const t0 = now();
  for (let i = 0; i < N; i++) a.getText("t").insert(10 + i, tA[i]);
  for (let i = 0; i < N; i++) b.getText("t").insert(BASE.length + i, tB[i]);
  b.getText("t").format(0, 9, { bold: true });
  b.getText("t").format(20, 10, { link: "https://example.com" });
  const edit = ms(t0);
  const ua = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const ub = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  const t1 = now();
  Y.applyUpdate(a, ub); Y.applyUpdate(b, ua);
  const merge = ms(t1);
  const ok = a.getText("t").toString() === b.getText("t").toString() &&
             JSON.stringify(a.getText("t").toDelta()) === JSON.stringify(b.getText("t").toDelta());
  const x = new Y.Doc(); x.clientID = 3; x.getText("t").insert(0, "Hallo Welt");
  const y = new Y.Doc(); y.clientID = 4; Y.applyUpdate(y, Y.encodeStateAsUpdate(x));
  [..."abc"].forEach((c, i) => x.getText("t").insert(5 + i, c));
  [..."xyz"].forEach((c, i) => y.getText("t").insert(5 + i, c));
  Y.applyUpdate(x, Y.encodeStateAsUpdate(y));
  return { lib: "Yjs 13.6.33", edit, merge, converged: ok, chars: a.getText("t").length,
           snapshot: Y.encodeStateAsUpdate(a).length, marks: a.getText("t").toDelta().filter((d) => d.attributes).length,
           interleave: x.getText("t").toString() };
}

const rows = [automerge(), loro(), yjs()];
console.table(rows);
