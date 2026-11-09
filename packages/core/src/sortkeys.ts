// Fraktionale Sortierschlüssel, portiert aus BasedCore Model/Identifiers.swift (FractionalIndex).
// Kinder eines Elternteils sind nach (sk, id) sortiert; Einfügen wählt einen Schlüssel zwischen den Nachbarn.
// Verifiziert über fixtures/sortkeys/sortkeys.json (BSD-151, Teil 1).

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const LOOKUP = new Map([...DIGITS].map((c, i) => [c, i] as const));
const SMALLEST_INTEGER = "A" + "0".repeat(26);
export const FIRST_KEY = "a0";

function integerLength(head: string): number | undefined {
  const v = head.charCodeAt(0);
  if (v >= 97 && v <= 122) return v - 97 + 2; // a…z
  if (v >= 65 && v <= 90) return 90 - v + 2; // A…Z
  return undefined;
}

function integerPart(key: string): string | undefined {
  if (key.length === 0) return undefined;
  const len = integerLength(key[0]!);
  if (len === undefined || len > key.length) return undefined;
  return key.slice(0, len);
}

export function isValidKey(key: string): boolean {
  const int = integerPart(key);
  if (int === undefined) return false;
  const frac = key.slice(int.length);
  if (frac.endsWith("0")) return false;
  return [...key.slice(1)].every((c) => LOOKUP.has(c));
}

function increment(x: string): string | undefined {
  const head = x[0]!;
  const chars = [...x.slice(1)];
  for (let i = chars.length - 1; i >= 0; i--) {
    const d = (LOOKUP.get(chars[i]!) ?? 0) + 1;
    if (d === DIGITS.length) chars[i] = "0";
    else {
      chars[i] = DIGITS[d]!;
      return head + chars.join("");
    }
  }
  if (head === "Z") return "a0";
  if (head === "z") return undefined;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > "a") chars.push("0");
  else chars.pop();
  return h + chars.join("");
}

function decrement(x: string): string | undefined {
  const head = x[0]!;
  const chars = [...x.slice(1)];
  for (let i = chars.length - 1; i >= 0; i--) {
    const d = (LOOKUP.get(chars[i]!) ?? 0) - 1;
    if (d < 0) chars[i] = DIGITS[DIGITS.length - 1]!;
    else {
      chars[i] = DIGITS[d]!;
      return head + chars.join("");
    }
  }
  if (head === "a") return "Z" + DIGITS[DIGITS.length - 1];
  if (head === "A") return undefined;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < "Z") chars.push(DIGITS[DIGITS.length - 1]!);
  else chars.pop();
  return h + chars.join("");
}

/** Mittelpunkt zweier Nachkommastellen-Folgen (auch vom Altverfahren genutzt). */
function midpoint(a: string[], b: string[] | undefined): string {
  if (b !== undefined) {
    let n = 0;
    while (n < b.length && (n < a.length ? a[n] : "0") === b[n]) n++;
    if (n > 0) return b.slice(0, n).join("") + midpoint(n < a.length ? a.slice(n) : [], b.slice(n));
  }
  const digitA = a.length === 0 ? 0 : (LOOKUP.get(a[0]!) ?? 0);
  const digitB = b === undefined ? DIGITS.length : b.length === 0 ? DIGITS.length : (LOOKUP.get(b[0]!) ?? DIGITS.length);
  if (digitB - digitA > 1) return DIGITS[Math.round((digitA + digitB) * 0.5)]!;
  if (b !== undefined && b.length > 1) return b[0]!;
  return DIGITS[digitA]! + midpoint(a.length === 0 ? [] : a.slice(1), undefined);
}

/** Altbestand (Schlüssel vor dem Fraktions-Index). */
function legacyBetween(a: string | undefined, b: string | undefined): string {
  let lo = a ?? "";
  let hi = b;
  if (hi !== undefined && lo !== "" && hi <= lo) hi = undefined;
  if (lo.endsWith("0")) lo = lo.replace(/0+$/, "");
  return midpoint([...lo], hi === undefined ? undefined : [...hi]);
}

/** Schlüssel zwischen `a` und `b` (`undefined` = Anfang bzw. Ende). */
export function keyBetween(a?: string | null, b?: string | null): string {
  const A = a ?? undefined, B = b ?? undefined;
  if (A !== undefined && B !== undefined && A >= B) return legacyBetween(A, undefined); // falsche Reihenfolge reparieren
  if (A !== undefined && !isValidKey(A)) return legacyBetween(A, B);
  if (B !== undefined && !isValidKey(B)) return legacyBetween(A, B);
  if (A === undefined) {
    if (B === undefined) return FIRST_KEY;
    const ib = integerPart(B)!;
    const fb = B.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint([], [...fb]);
    if (fb.length > 0) return ib;
    return decrement(ib) ?? legacyBetween(undefined, B);
  }
  const ia = integerPart(A)!;
  const fa = A.slice(ia.length);
  if (B === undefined) return increment(ia) ?? ia + midpoint([...fa], undefined);
  const ib = integerPart(B)!;
  const fb = B.slice(ib.length);
  if (ia === ib) return ia + midpoint([...fa], [...fb]);
  const i = increment(ia);
  if (i !== undefined && i < B) return i;
  return ia + midpoint([...fa], undefined);
}

/** `count` aufsteigende Schlüssel zwischen `a` und `b`. */
export function keysBetween(count: number, a?: string | null, b?: string | null): string[] {
  if (count <= 0) return [];
  if (count === 1) return [keyBetween(a, b)];
  if (b == null) {
    let c = keyBetween(a, undefined);
    const out = [c];
    for (let i = 1; i < count; i++) {
      c = keyBetween(c, undefined);
      out.push(c);
    }
    return out;
  }
  if (a == null) {
    let c = keyBetween(undefined, b);
    const out = [c];
    for (let i = 1; i < count; i++) {
      c = keyBetween(undefined, c);
      out.push(c);
    }
    return out.reverse();
  }
  const mid = Math.floor(count / 2);
  const c = keyBetween(a, b);
  return [...keysBetween(mid, a, c), c, ...keysBetween(count - mid - 1, c, b)];
}
