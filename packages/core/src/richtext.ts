// RichText-Hilfen (Ausschnitt aus BasedCore Model/RichText.swift).
import type { RichText } from "./model/records.js";

/** Reiner Text ohne Formatierung (Swift `RichText.plainText`). */
export function plainText(t: RichText | undefined): string {
  if (t === undefined) return "";
  if (typeof t === "string") return t;
  return t.map((r) => r.t ?? "").join("");
}
