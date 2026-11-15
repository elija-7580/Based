// BSD-410: kleiner Zeilen-Diff (LCS) für Datei-Änderungen von Agenten wie in Claude Code: `-` entfernt, `+` neu,
// ` ` Kontext. Port von Swift `LineDiff` (BasedBrain/Agent/LineDiff.swift), geprüft gegen fixtures/agents/linediff.json.
// `firstLine(of:inFile:)` (Datei lesen) bleibt in der Hülle bzw. im Server; hier nur Text.
//
// Bewusste Abweichung: Swift vergleicht Zeilen kanonisch (é vorkomponiert == e + ◌́), TS Zeichen für Zeichen.

export type LineOp = ["same" | "removed" | "added", string];

const lines = (s: string) => (s === "" ? [] : s.split("\n"));

/** Zeilen-Operationen von `old` nach `neu`. Große Eingaben: „alles entfernt, alles neu“ (wie Swift). */
export function lineOps(old: string, neu: string): LineOp[] {
  const a = lines(old), b = lines(neu);
  // Gemeinsamer Anfang und Ende zuerst: Änderungen sind meist kleine Stellen großer Texte.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ma = a.slice(pre, a.length - suf), mb = b.slice(pre, b.length - suf);
  const out: LineOp[] = a.slice(0, pre).map((s) => ["same", s]);
  if (ma.length * mb.length > 2_000_000) {
    for (const s of ma) out.push(["removed", s]);
    for (const s of mb) out.push(["added", s]);
  } else {
    const n = ma.length, m = mb.length;
    // LCS-Tabelle (n+1)×(m+1), flach
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = ma[i] === mb[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && ma[i] === mb[j]) { out.push(["same", ma[i]!]); i++; j++; }
      else if (i < n && (j === m || t[(i + 1) * w + j]! >= t[i * w + j + 1]!)) { out.push(["removed", ma[i]!]); i++; }
      else { out.push(["added", mb[j]!]); j++; }
    }
  }
  for (const s of a.slice(a.length - suf)) out.push(["same", s]);
  return out;
}

export function lineCounts(ops: readonly LineOp[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const [k] of ops) {
    if (k === "added") added++;
    else if (k === "removed") removed++;
  }
  return { added, removed };
}

/**
 * Unified-Diff-Rumpf (Hunks mit `@@ -a,b +c,d @@`) mit `context` Zeilen um Änderungen.
 * `firstLine`: Zeilennummer der ersten Zeile im ganzen Dokument (Änderungen sind Ausschnitte).
 */
export function unifiedDiff(old: string, neu: string, context = 3, firstLine = 1): string {
  const all = lineOps(old, neu);
  const changed: number[] = [];
  all.forEach(([k], i) => { if (k !== "same") changed.push(i); });
  if (changed.length === 0) return "";
  const hunks: [number, number][] = [];
  for (const i of changed) {
    const lo = Math.max(0, i - context), hi = Math.min(all.length - 1, i + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else hunks.push([lo, hi]);
  }
  const oldLine: number[] = [], newLine: number[] = [];
  let o = Math.max(1, firstLine), n = Math.max(1, firstLine);
  for (const [k] of all) {
    oldLine.push(o); newLine.push(n);
    if (k === "same") { o++; n++; } else if (k === "removed") o++; else n++;
  }
  const out: string[] = [];
  for (const [lo, hi] of hunks) {
    const slice = all.slice(lo, hi + 1);
    const oc = slice.filter(([k]) => k !== "added").length, nc = slice.filter(([k]) => k !== "removed").length;
    out.push(`@@ -${oldLine[lo]},${oc} +${newLine[lo]},${nc} @@`);
    for (const [k, s] of slice) out.push((k === "same" ? " " : k === "removed" ? "-" : "+") + s);
  }
  return out.join("\n");
}

export interface DiffLine {
  kind: "hunk" | "same" | "added" | "removed";
  old?: number;
  new?: number;
  text: string;
}

/** Unified-Diff-Zeilen für die Anzeige: Art, alte/neue Zeilennummer, Text. */
export function parseUnified(unified: string): DiffLine[] {
  const out: DiffLine[] = [];
  let o = 0, n = 0;
  for (const raw of unified.split("\n")) {
    if (raw.startsWith("@@")) {
      const parts = raw.split(" ").filter((p) => p !== "");
      if (parts.length >= 3) {
        o = parseInt(parts[1]!.slice(1).split(",")[0] ?? "", 10);
        n = parseInt(parts[2]!.slice(1).split(",")[0] ?? "", 10);
        if (!Number.isFinite(o)) o = 1;
        if (!Number.isFinite(n)) n = 1;
      }
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    if (raw === "") continue;
    const first = [...raw][0]!;
    const text = raw.slice(first.length);
    if (first === "+") out.push({ kind: "added", new: n++, text });
    else if (first === "-") out.push({ kind: "removed", old: o++, text });
    else out.push({ kind: "same", old: o++, new: n++, text });
  }
  return out;
}
