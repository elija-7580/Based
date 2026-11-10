// BSD-199 / ADR 0013 §7, Stufe 1: Erkennung sensibler Stellen mit Regeln und Prüfsummen – sofort aktiv, lokal,
// deterministisch. E-Mail, Telefon, IBAN (Mod 97), Kartennummer (Luhn), Schlüssel/Tokens, Adressen (Heuristik)
// und Namen bekannter Personen (aus dem Workspace). Bestmöglich, keine Garantie.

export type RedactKind = "PERSON" | "EMAIL" | "PHONE" | "IBAN" | "CARD" | "ADDRESS" | "SECRET";

export const REDACT_KINDS: readonly RedactKind[] = ["PERSON", "EMAIL", "PHONE", "IBAN", "CARD", "ADDRESS", "SECRET"];

export const REDACT_KIND_LABELS: Record<RedactKind, string> = {
  PERSON: "Names", EMAIL: "Email addresses", PHONE: "Phone numbers", IBAN: "IBANs", CARD: "Card numbers", ADDRESS: "Addresses", SECRET: "Keys and tokens",
};

export interface Detection {
  start: number;
  end: number;
  kind: RedactKind;
  value: string;
}

/** Luhn-Prüfsumme (Kartennummern). */
export function luhnValid(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** IBAN-Prüfung nach ISO 13616 (Mod 97 = 1). */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/g;
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g;
// +49 30 1234567, 0049…, (030) 123 456, 030/1234567, 0151-12345678, +1 (555) 123-4567
const PHONE = /(?:(?<![\w+])\+|\b00|(?<![\w/.-])\(?0)\d[\d ()/.-]{5,}\d\b/g;
const SECRETS: RegExp[] = [
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(?<=\bBearer\s)[A-Za-z0-9._~+/-]{20,}=*/g,
  /(?<=\b(?:api[_-]?key|token|secret|password|passwort)\s*[:=]\s*["']?)[^\s"']{8,}/gi,
];
const STREET_WORD = "(?:stra(?:ss|ß)e|str\\.|weg|allee|platz|gasse|ring|damm|ufer|chaussee|steig|pfad)";
// „Hauptstraße 5“, „Berliner Straße 12a, 10115 Berlin“, „Am Markt 3“ (nur mit PLZ)
const ADDRESS_DE = new RegExp(
  `\\b(?:[A-ZÄÖÜ][\\p{L}-]*${STREET_WORD}|[A-ZÄÖÜ][\\p{L}-]+\\s+(?:Stra(?:ss|ß)e|Str\\.|Weg|Allee|Platz|Gasse|Ring|Damm|Ufer))\\s+\\d{1,4}\\s?[a-zA-Z]?\\b(?:,?\\s+\\d{5}\\s+[A-ZÄÖÜ][\\p{L}-]+(?:\\s(?:am|an der|im)\\s[A-ZÄÖÜ][\\p{L}-]+)?)?`,
  "gu",
);
const ADDRESS_EN = /\b\d{1,5}\s+(?:[A-Z][A-Za-z]+\s+){1,3}(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Lane|Ln\.|Boulevard|Blvd\.|Drive|Dr\.|Court|Ct\.|Way)(?:,?\s+[A-Z][A-Za-z]+(?:,?\s+[A-Z]{2})?\s+\d{5})?/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Namen fürs Erkennen: ganze Namen und deren Teile (ab 3 Zeichen, großgeschrieben), längste zuerst. */
export function nameVariants(names: readonly string[]): string[] {
  const set = new Set<string>();
  for (const raw of names) {
    const n = raw.trim().replace(/\s+/g, " ");
    if (n.length < 3) continue;
    set.add(n);
    for (const part of n.split(" ")) if (part.length >= 3 && /^\p{Lu}/u.test(part)) set.add(part);
  }
  return [...set].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

function collect(text: string, re: RegExp, kind: RedactKind, ok: (v: string) => boolean = () => true): Detection[] {
  const out: Detection[] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const v = m[0].replace(/[\s.,;:]+$/, "");
    if (!v || !ok(v)) continue;
    out.push({ start: m.index, end: m.index + v.length, kind, value: v });
  }
  return out;
}

export interface RuleOptions {
  /** Bekannte Personen (Workspace-Mitglieder, Memories vom Typ People …). */
  names?: readonly string[];
  /** Nur diese Arten (Standard: alle). */
  kinds?: ReadonlySet<RedactKind>;
}

/** Alle Fundstellen, ohne Überlappung (früher und länger gewinnt; Prüfsummen-Arten vor Telefon). */
export function detectSensitive(text: string, opts: RuleOptions = {}): Detection[] {
  const want = (k: RedactKind) => !opts.kinds || opts.kinds.has(k);
  // Reihenfolge = Vorrang bei Überlappung.
  const found: Detection[] = [];
  if (want("SECRET")) for (const re of SECRETS) found.push(...collect(text, re, "SECRET"));
  if (want("EMAIL")) found.push(...collect(text, EMAIL, "EMAIL"));
  if (want("IBAN")) found.push(...collect(text, IBAN, "IBAN", ibanValid));
  if (want("CARD")) found.push(...collect(text, CARD, "CARD", (v) => luhnValid(v.replace(/[ -]/g, ""))));
  if (want("ADDRESS")) found.push(...collect(text, ADDRESS_DE, "ADDRESS"), ...collect(text, ADDRESS_EN, "ADDRESS"));
  if (want("PHONE")) {
    found.push(...collect(text, PHONE, "PHONE", (v) => {
      const digits = v.replace(/\D/g, "");
      // Daten (2026-11-10, 10.11.2026) und kurze Zahlen sind keine Telefonnummern.
      if (digits.length < 7 || digits.length > 15) return false;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(v)) return false;
      return true;
    }));
  }
  if (want("PERSON") && opts.names && opts.names.length > 0) {
    const variants = nameVariants(opts.names);
    if (variants.length > 0) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${variants.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "gu");
      found.push(...collect(text, re, "PERSON"));
    }
  }
  return resolveOverlaps(found);
}

/** Überlappende Fundstellen auflösen: die zuerst gelistete Art gewinnt, sonst die längere. */
export function resolveOverlaps(found: readonly Detection[]): Detection[] {
  const ranked = found.map((d, i) => ({ d, i })).sort((a, b) => a.i - b.i);
  const taken: Detection[] = [];
  for (const { d } of ranked) {
    if (taken.some((t) => d.start < t.end && t.start < d.end)) continue;
    taken.push(d);
  }
  return taken.sort((a, b) => a.start - b.start);
}
