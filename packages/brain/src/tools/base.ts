// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Agent-Parität (docs/agent-parity.md, Regel 1): die eine Werkzeug-Schicht. Hier liegt, was jede Werkzeug-Datei
// braucht: die Definition eines Werkzeugs, Schema-Helfer, die Prüfung der Argumente und kleine Text-Helfer.
import type { Author, JSONValue } from "@based/core";
import type { ToolSpec } from "../messages.js";

export const PAGE_URI = "based://page/";

/** Fehler, den ein Werkzeug dem Modell als Antwort (isError) zurückgibt. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export type Args = { [key: string]: JSONValue };

/**
 * Bereich eines Werkzeugs. Ein Host wählt Bereiche aus (`WorkspaceToolsOptions.groups`), z. B. der Chat in der App
 * ohne „agents“, weil er Läufe und Freigaben selbst führt.
 */
export type ToolGroup = "pages" | "blocks" | "boards" | "files" | "databases" | "brain" | "agents";

export interface ToolRunContext {
  /** Als wer geschrieben wird (async-Werkzeuge setzen ihn selbst um ihre Schreibschritte). */
  actor: Author;
}

export interface ToolDef {
  spec: ToolSpec;
  group: ToolGroup;
  /** Ändert das Werkzeug etwas im Workspace? */
  write: boolean;
  /** Kann es etwas verwerfen, das nicht mit einem Klick zurückkommt (Inhalt ersetzen, Property löschen …)? */
  destructive?: boolean;
  /** Steht auch in der kurzen Werkzeugliste (tools/gateway.ts); alles andere erreicht ein Agent über more_tools/run_tool. */
  core?: boolean;
  /**
   * Läuft nie auf Wunsch eines Agenten allein: der Aufruf wird als Rückfrage in der Inbox abgelegt und erst
   * ausgeführt, wenn ein Mensch in Based zustimmt. Der Titel sagt dem Menschen, was passieren würde; `undefined`
   * heißt: diesmal ohne Rückfrage (z. B. weil der Mensch Agenten freies Arbeiten erlaubt hat).
   */
  ask?: (args: Args) => string | undefined;
  /** Frühere Namen von Argumenten (`page_id` → `id`); werden still angenommen, stehen aber nicht im Schema. */
  aliases?: Record<string, string>;
  /** Das Werkzeug schreibt und muss dabei warten (Netz, Dateien): es läuft nicht als eine Transaktion, siehe `run`. */
  wait?: boolean;
  /**
   * Schreibend und synchron: läuft als EINE Transaktion (`store.atomic`) und als Agent. Lesende Werkzeuge dürfen ein
   * Promise zurückgeben (Suche nach Bedeutung). Schreibende mit `wait` schreiben über `ctx.callSync(…, actor)`.
   */
  run: (args: Args, ctx: ToolRunContext) => string | Promise<string>;
}

// MARK: Schema

export const obj = (properties: Record<string, JSONValue>, required: string[] = []): JSONValue => ({ type: "object", properties, required, additionalProperties: false });
export const S = { type: "string" } as const;
export const str = (description: string): JSONValue => ({ type: "string", description });
export const bool = (description: string): JSONValue => ({ type: "boolean", description });
export const pageID = { type: "string", description: "Page id (UUID)" } as const;
export const limitSchema = { type: "integer", minimum: 1, maximum: 500, description: "Max items (default 50)" } as const;
export const offsetSchema = { type: "integer", minimum: 0, description: "Skip this many items" } as const;
export const stringMap = (description: string): JSONValue => ({ type: "object", additionalProperties: { type: "string" }, description });

interface Schema {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  enum?: JSONValue[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  items?: Schema;
}

function checkValue(name: string, v: JSONValue, s: Schema): JSONValue {
  const fail = (what: string): never => {
    throw new ToolError(`Argument ${name} must be ${what}.`);
  };
  switch (s.type) {
    case "string": {
      // Modelle schicken Zahlen und Wahrheitswerte gelegentlich ohne Anführungszeichen.
      const out = typeof v === "number" || typeof v === "boolean" ? String(v) : v;
      if (typeof out !== "string") return fail("a string");
      if (s.minLength !== undefined && out.length < s.minLength) throw new ToolError(`Argument ${name} must not be empty.`);
      if (s.maxLength !== undefined && out.length > s.maxLength) throw new ToolError(`Argument ${name} is too long (max ${s.maxLength} characters).`);
      if (s.enum && !s.enum.includes(out)) throw new ToolError(`Argument ${name} must be one of: ${s.enum.join(", ")}.`);
      return out;
    }
    case "integer":
    case "number": {
      const n = typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n)) return fail("a number");
      if (s.type === "integer" && !Number.isInteger(n)) return fail("a whole number");
      if (s.minimum !== undefined && n < s.minimum) throw new ToolError(`Argument ${name} must be at least ${s.minimum}.`);
      if (s.maximum !== undefined && n > s.maximum) throw new ToolError(`Argument ${name} must be at most ${s.maximum}.`);
      return n;
    }
    case "boolean": {
      if (v === "true") return true;
      if (v === "false") return false;
      if (typeof v !== "boolean") return fail("true or false");
      return v;
    }
    case "array": {
      if (!Array.isArray(v)) return fail("a list");
      if (s.maxItems !== undefined && v.length > s.maxItems) throw new ToolError(`Argument ${name} takes at most ${s.maxItems} items.`);
      return s.items ? v.map((x, i) => checkValue(`${name}[${i}]`, x, s.items!)) : v;
    }
    case "object": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return fail("an object");
      if (s.properties) return checkObject(v, s, name + ".");
      if (s.additionalProperties && typeof s.additionalProperties === "object") {
        const out: Args = {};
        for (const [k, x] of Object.entries(v)) out[k] = checkValue(`${name}.${k}`, x, s.additionalProperties);
        return out;
      }
      return v;
    }
    default:
      return v;
  }
}

function checkObject(input: Args, s: Schema, prefix = ""): Args {
  const props = s.properties ?? {};
  const out: Args = {};
  for (const [k, v] of Object.entries(input)) {
    // weggelassen und „null“ sind dasselbe
    if (v === null || v === undefined) continue;
    const ps = props[k];
    if (!ps) {
      if (s.additionalProperties === false) throw new ToolError(`Unknown argument ${prefix}${k}. Arguments: ${Object.keys(props).join(", ") || "(none)"}.`);
      out[k] = v;
      continue;
    }
    out[k] = checkValue(prefix + k, v, ps);
  }
  for (const k of s.required ?? []) if (out[k] === undefined) throw new ToolError(`Missing argument ${prefix}${k}.`);
  return out;
}

/**
 * Argumente gegen das Schema des Werkzeugs prüfen, bevor irgendetwas läuft: unbekannte Namen, fehlende Pflichtfelder,
 * falsche Arten. Die Meldung sagt, was richtig wäre. Frühere Namen (`aliases`) werden auf die heutigen umgeschrieben.
 */
export function checkArgs(def: ToolDef, input: JSONValue): Args {
  const raw: Args = input !== null && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  for (const [old, now] of Object.entries(def.aliases ?? {})) {
    if (raw[old] === undefined) continue;
    if (raw[now] === undefined) raw[now] = raw[old]!;
    delete raw[old];
  }
  return checkObject(raw, def.spec.inputSchema as Schema);
}

// MARK: Text

/** Liste mit `limit`/`offset`, Rest als „… N more (offset: K)“. */
export function paged(lines: string[], limit: number, offset: number): string {
  const slice = lines.slice(offset, offset + limit);
  const rest = lines.length - offset - slice.length;
  const out = slice.length > 0 ? slice.join("\n") : "(none)";
  return rest > 0 ? `${out}\n… ${rest} more (offset: ${offset + slice.length})` : out;
}

export const optStr = (a: Args, k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string) : undefined);
export const needStr = (a: Args, k: string): string => {
  const v = optStr(a, k);
  if (v === undefined || v === "") throw new ToolError(`Missing argument ${k}.`);
  return v;
};
export const optNum = (a: Args, k: string, fallback: number): number => (typeof a[k] === "number" ? Math.max(0, Math.floor(a[k] as number)) : fallback);

// Markdown-Blöcke in einer Transaktion schreiben: die Logik liegt im Kern (editor/agent.ts), hier nur der alte Importweg.
export { putMarkdownBlocks } from "@based/core";
