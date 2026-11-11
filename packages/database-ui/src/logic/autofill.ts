// BSD-225 Teil 2: Datenbank-Property per AI ausfüllen (wie Swift BrainModel.autofill und Notions „AI autofill“).
// Rein bis auf `runAutofill`: Prompt je Zeile, Antwort → gespeicherter Wert. Die Shell liefert nur `write` (das
// eingestellte Modell oder die Skript-Engine in Tests). Alle Werte landen am Ende in EINEM Undo-Schritt.
import { plainText, rowsOf, titleOf, type Database, type PropertySchema, type PropertyValue, type WorkspaceStore } from "@based/core";

export const AUTOFILL_TYPES: ReadonlySet<string> = new Set(["text", "select", "status", "multiSelect", "checkbox"]);

export const AUTOFILL_SYSTEM =
  "You fill in one property of a database row in a notes app. Reply with the value only: no explanation, no quotes, no Markdown, no label.";

export interface AutofillWriter {
  write(system: string, prompt: string, signal: AbortSignal): Promise<string>;
  available(): boolean;
}

/** Text einer Zeile für den Prompt: Titel und Inhalt der Zeilenseite (gekürzt). */
export function rowContext(store: WorkspaceStore, rowID: string, max = 3000): string {
  const lines = [titleOf(store, rowID) || "Untitled"];
  const walk = (parent: string, depth: number) => {
    for (const id of store.children(parent)) {
      const b = store.blocks.get(id);
      if (!b || b.trashedAt !== undefined) continue;
      const t = plainText(b.text);
      if (t) lines.push(t);
      if (depth < 3) walk("b:" + id, depth + 1);
    }
  };
  walk("b:" + rowID, 0);
  const text = lines.join("\n");
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const optionNames = (p: PropertySchema) => (p.options ?? []).map((o) => o.name);

export function autofillPrompt(p: PropertySchema, context: string): string {
  const ask =
    p.type === "select" || p.type === "status" ? `Choose exactly one of: ${optionNames(p).join(", ")}. Reply with the option name only.`
    : p.type === "multiSelect" ? `Choose zero or more of: ${optionNames(p).join(", ")}. Reply comma-separated, or nothing.`
    : p.type === "checkbox" ? "Answer yes or no."
    : "Reply with a short value (one line).";
  return `Property: ${p.name}\n${ask}\n\nRow:\n${context}`;
}

const clean = (s: string) => s.trim().replace(/^["'`]+|["'`.]+$/g, "").trim();

/** Antwort → gespeicherter Wert; `undefined` = nichts Brauchbares (Zeile bleibt, wie sie ist). */
export function autofillValue(p: PropertySchema, answer: string): PropertyValue | null | undefined {
  const a = clean(answer.split("\n").find((l) => l.trim()) ?? "");
  const byName = (n: string) => p.options?.find((o) => o.name.toLowerCase() === clean(n).toLowerCase());
  switch (p.type) {
    case "select": case "status": {
      const o = byName(a);
      return o ? ({ [p.type]: { _0: o.id } } as PropertyValue) : undefined;
    }
    case "multiSelect": {
      if (!a || /^(none|nothing|-)$/i.test(a)) return null;
      const ids = [...new Set(a.split(",").map((x) => byName(x)?.id).filter((x): x is string => !!x))];
      return ids.length ? ({ multiSelect: { _0: ids } } as PropertyValue) : undefined;
    }
    case "checkbox":
      return /^(y|yes|true|ja)\b/i.test(a) ? ({ checkbox: { _0: true } } as PropertyValue) : /^(n|no|false|nein)\b/i.test(a) ? ({ checkbox: { _0: false } } as PropertyValue) : undefined;
    case "text":
      return a ? ({ text: { _0: a } } as PropertyValue) : undefined;
    default:
      return undefined;
  }
}

export interface AutofillProgress { done: number; total: number; filled: number }

/** Füllt die Property für alle Zeilen (ohne Vorlagen). Abbrechbar; geschrieben wird am Ende in einem Schritt. */
export async function runAutofill(store: WorkspaceStore, db: Database, p: PropertySchema, ai: AutofillWriter, signal: AbortSignal, onProgress?: (s: AutofillProgress) => void): Promise<AutofillProgress> {
  const rows = rowsOf(store, db.id).filter((r) => r.props?.isTemplate !== true);
  const results = new Map<string, PropertyValue | null>();
  const s: AutofillProgress = { done: 0, total: rows.length, filled: 0 };
  onProgress?.({ ...s });
  for (const r of rows) {
    if (signal.aborted) break;
    try {
      const v = autofillValue(p, await ai.write(AUTOFILL_SYSTEM, autofillPrompt(p, rowContext(store, r.id)), signal));
      if (v !== undefined) results.set(r.id, v);
    } catch {
      if (signal.aborted) break;
    }
    s.done++;
    onProgress?.({ ...s, filled: results.size });
  }
  if (results.size) {
    store.transact("Autofill with AI", (tx) => {
      for (const [id, v] of results) {
        if (!store.blocks.has(id)) continue;
        tx.update(id, (x) => {
          const values = { ...(x.values ?? {}) };
          if (v === null) delete values[p.id];
          else values[p.id] = v;
          if (Object.keys(values).length) x.values = values;
          else delete x.values;
        });
      }
    });
  }
  s.filled = results.size;
  return s;
}
