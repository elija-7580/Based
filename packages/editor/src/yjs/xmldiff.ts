// BSD-154: Einen Y-XML-Baum an einen Zielbaum angleichen – mit möglichst kleinen Änderungen (Attribute
// einzeln, Kinder per LCS über Knotenname + Block-ID). Damit landen Änderungen aus dem Store (Sync, Agenten,
// andere Ansichten) im Y.Doc, ohne die lokale Undo-Historie oder Cursor unnötig zu stören.
import { canonicalStringify } from "@based/core";
import * as Y from "yjs";

type Node = Y.XmlElement | Y.XmlText | Y.XmlHook;
type Parent = Y.XmlFragment | Y.XmlElement;

const keyOf = (n: unknown): string => {
  if (n instanceof Y.XmlText) return "#text";
  if (n instanceof Y.XmlElement) return n.nodeName + "#" + String(n.getAttribute("id") ?? "");
  return "#other";
};

const cloneNode = (n: Node): Node => n.clone() as Node;

/** Gleicht `live` (Kinder eines Fragments oder Elements) an `target` an. Muss in einer Transaktion laufen. */
export function syncChildren(live: Parent, target: Parent): void {
  const L = live.toArray() as Node[];
  const T = target.toArray() as Node[];
  let start = 0;
  while (start < L.length && start < T.length && keyOf(L[start]) === keyOf(T[start])) start++;
  let endL = L.length, endT = T.length;
  while (endL > start && endT > start && keyOf(L[endL - 1]) === keyOf(T[endT - 1])) {
    endL--;
    endT--;
  }
  // LCS über den mittleren Teil.
  const n = endL - start, m = endT - start;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = keyOf(L[start + i]) === keyOf(T[start + j]) ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  type Op = { kind: "keep"; l: number; t: number } | { kind: "del"; l: number } | { kind: "ins"; at: number; t: number };
  const ops: Op[] = [];
  for (let k = 0; k < start; k++) ops.push({ kind: "keep", l: k, t: k });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && keyOf(L[start + i]) === keyOf(T[start + j])) {
      ops.push({ kind: "keep", l: start + i, t: start + j });
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      ops.push({ kind: "ins", at: start + i, t: start + j });
      j++;
    } else {
      ops.push({ kind: "del", l: start + i });
      i++;
    }
  }
  for (let k = 0; k < L.length - endL; k++) ops.push({ kind: "keep", l: endL + k, t: endT + k });
  // Erst die behaltenen Knoten angleichen (ändert keine Indizes), dann Struktur von hinten nach vorn.
  for (const op of ops) if (op.kind === "keep") syncNode(L[op.l]!, T[op.t]!);
  for (let k = ops.length - 1; k >= 0; k--) {
    const op = ops[k]!;
    if (op.kind === "del") live.delete(op.l, 1);
    else if (op.kind === "ins") live.insert(op.at, [cloneNode(T[op.t]!)] as never);
  }
}

function syncNode(l: Node, t: Node): void {
  if (l instanceof Y.XmlText && t instanceof Y.XmlText) {
    const a = l.toDelta(), b = t.toDelta();
    if (canonicalStringify(a) === canonicalStringify(b)) return;
    syncText(l, a, b);
    return;
  }
  if (l instanceof Y.XmlElement && t instanceof Y.XmlElement) {
    const la = l.getAttributes() as Record<string, unknown>, ta = t.getAttributes() as Record<string, unknown>;
    for (const k of Object.keys(la)) if (!(k in ta)) l.removeAttribute(k);
    for (const [k, v] of Object.entries(ta)) {
      if (canonicalStringify(la[k] ?? null) !== canonicalStringify(v ?? null)) l.setAttribute(k, v as string);
    }
    syncChildren(l, t);
  }
}

type DeltaOp = { insert?: unknown; attributes?: Record<string, unknown> };

/** Text angleichen: gemeinsamen Anfang/Ende behalten, nur die Mitte ersetzen. */
function syncText(l: Y.XmlText, a: DeltaOp[], b: DeltaOp[]): void {
  const flat = (d: DeltaOp[]) => {
    const chars: { c: string; attrs: string }[] = [];
    for (const op of d) {
      if (typeof op.insert !== "string") return undefined; // Einbettungen: ganz ersetzen
      const attrs = canonicalStringify(op.attributes ?? {});
      for (const c of op.insert) chars.push({ c, attrs });
    }
    return chars;
  };
  const fa = flat(a), fb = flat(b);
  if (!fa || !fb) {
    l.delete(0, l.length);
    l.applyDelta(b);
    return;
  }
  // Längen in UTF-16-Einheiten (Yjs zählt wie JS-Strings).
  let s = 0;
  while (s < fa.length && s < fb.length && fa[s]!.c === fb[s]!.c && fa[s]!.attrs === fb[s]!.attrs) s++;
  let ea = fa.length, eb = fb.length;
  while (ea > s && eb > s && fa[ea - 1]!.c === fb[eb - 1]!.c && fa[ea - 1]!.attrs === fb[eb - 1]!.attrs) {
    ea--;
    eb--;
  }
  const units = (chars: { c: string }[], from: number, to: number) => chars.slice(from, to).reduce((n, x) => n + x.c.length, 0);
  const pos = units(fa, 0, s);
  const delLen = units(fa, s, ea);
  if (delLen > 0) l.delete(pos, delLen);
  // Einfügen in Abschnitten gleicher Attribute.
  let at = pos;
  let k = s;
  while (k < eb) {
    let e = k;
    let text = "";
    while (e < eb && fb[e]!.attrs === fb[k]!.attrs) text += fb[e++]!.c;
    const attrs = JSON.parse(fb[k]!.attrs) as Record<string, unknown>;
    l.insert(at, text, Object.keys(attrs).length ? attrs : {});
    at += text.length;
    k = e;
  }
}
