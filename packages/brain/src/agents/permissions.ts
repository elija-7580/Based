// BSD-160 / BSD-50 + BSD-98 (Swift `AgentPermissions`, `PermissionLayers`): Berechtigungen wie in Claude Code –
// ein Modus (Composer-Pille: Ask / Ask before edits / Work freely) plus Regeln `allow|ask|deny Tool(muster)`,
// geschichtet global → Projekt → Agent. Vorrang: deny > ask > allow > Modus.
// Werkzeugnamen: die Chat-Werkzeuge als `based.<name>` (z. B. `based.create_page`), die Aktionen des Hauptagenten
// ebenso (`based.spawn_agent`, `based.file_to_project` …); `based.*` trifft alle. Das Muster prüft das Hauptargument
// (Seiten-ID, Projektname, Titel) als Glob (`*`, `?`, ohne Groß/Klein).
import type { PermissionMode } from "../engine.js";
import type { JSONValue } from "@based/core";

export type PermissionEffect = "allow" | "ask" | "deny";

export interface PermissionRule {
  effect: PermissionEffect;
  tool: string;
  pattern?: string;
}

export interface PermissionCall {
  tool: string;
  argument?: string | undefined;
}

export interface PermissionVerdict {
  effect: PermissionEffect;
  reason: string;
}

export const ruleText = (r: PermissionRule) => `${r.effect} ${r.tool}${r.pattern !== undefined ? `(${r.pattern})` : ""}`;

/** `*`/`?`-Glob ohne Groß/Klein. */
export function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp("^" + pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "s");
  return re.test(text.toLowerCase());
}

/** `Tool` oder `Tool(muster)`. */
export function parseRuleSpec(effect: PermissionEffect, spec: string): PermissionRule | undefined {
  const s = spec.trim();
  if (!s) return undefined;
  const open = s.indexOf("(");
  if (open >= 0) {
    if (!s.endsWith(")")) return undefined;
    const tool = s.slice(0, open).trim();
    const arg = s.slice(open + 1, -1).trim();
    if (!tool) return undefined;
    return arg === "" || arg === "*" ? { effect, tool } : { effect, tool, pattern: arg };
  }
  return s.includes(")") ? undefined : { effect, tool: s };
}

export function parseMode(s: string): PermissionMode | undefined {
  const k = s.toLowerCase().replace(/[\s_-]/g, "");
  if (["ask", "askpermissions", "askalways"].includes(k)) return "ask";
  if (["askedits", "askbeforeedits", "default", "acceptedits"].includes(k)) return "askEdits";
  if (["free", "workfreely", "bypass", "alloweverything"].includes(k)) return "free";
  return undefined;
}

/**
 * Regeltext: eine Regel je Zeile (`allow …`, `ask …`, `deny …`; Aufzählungszeichen, `#`-Kommentare und Backticks
 * werden ignoriert), optional `mode <modus>`; oder Claude-Code-JSON `{"permissions": {"allow": [...], ...}}`.
 * Unlesbare Zeilen kommen in `errors`, statt still wegzufallen.
 */
export function parseLayer(text: string): { mode?: PermissionMode; rules: PermissionRule[]; errors: string[] } {
  const rules: PermissionRule[] = [], errors: string[] = [];
  let mode: PermissionMode | undefined;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const v = JSON.parse(trimmed) as { permissions?: Record<string, JSONValue> } & Record<string, JSONValue>;
      const p = (v.permissions ?? v) as Record<string, JSONValue>;
      for (const e of ["deny", "ask", "allow"] as const) {
        const list = p[e];
        if (!Array.isArray(list)) continue;
        for (const s of list) {
          const r = typeof s === "string" ? parseRuleSpec(e, s) : undefined;
          if (r) rules.push(r);
          else errors.push(String(s));
        }
      }
      if (typeof p.defaultMode === "string") mode = parseMode(p.defaultMode);
      return { ...(mode ? { mode } : {}), rules, errors };
    } catch {
      return { rules, errors: ["invalid JSON"] };
    }
  }
  for (const raw of text.split("\n")) {
    let line = raw.trim().replace(/^(- \[[ x]\] |[-*•] )/, "").replace(/`/g, "").trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const m = /^(\w+):?\s+(.+)$/.exec(line);
    const head = m?.[1]?.toLowerCase();
    if (head === "mode") {
      const md = parseMode(m![2]!);
      if (md) mode = md;
      else errors.push(line);
      continue;
    }
    line = m?.[2] ?? "";
    const r = head === "allow" || head === "ask" || head === "deny" ? parseRuleSpec(head, line) : undefined;
    if (r) rules.push(r);
    else errors.push(raw.trim());
  }
  return { ...(mode ? { mode } : {}), rules, errors };
}

export function ruleMatches(r: PermissionRule, call: PermissionCall): boolean {
  if (!globMatch(r.tool, call.tool)) return false;
  if (r.pattern === undefined) return true;
  return call.argument !== undefined && globMatch(r.pattern, call.argument);
}

export class Permissions {
  constructor(readonly mode: PermissionMode = "askEdits", readonly rules: readonly PermissionRule[] = []) {}

  static from(text: string, mode: PermissionMode = "askEdits"): Permissions {
    const l = parseLayer(text);
    return new Permissions(l.mode ?? mode, l.rules);
  }

  /** Eine genauere Schicht (Projekt, Agent): Regeln kommen dazu, ihr Modus gewinnt, wenn gesetzt. */
  layered(text: string | undefined): Permissions {
    if (!text?.trim()) return this;
    const l = parseLayer(text);
    return new Permissions(l.mode ?? this.mode, [...this.rules, ...l.rules]);
  }

  /** Nur was die Regeln sagen (`undefined`: keine Regel greift). */
  ruleVerdict(call: PermissionCall): PermissionVerdict | undefined {
    const hits = this.rules.filter((r) => ruleMatches(r, call));
    for (const e of ["deny", "ask", "allow"] as const) {
      const r = hits.find((h) => h.effect === e);
      if (r) return { effect: e, reason: `rule “${ruleText(r)}”` };
    }
    return undefined;
  }

  /** Urteil für einen Werkzeugaufruf: Regeln, sonst Modus (`write` = ändert etwas). */
  decide(call: PermissionCall, write: boolean): PermissionVerdict {
    const r = this.ruleVerdict(call);
    if (r) return r;
    if (!write || this.mode === "free") return { effect: "allow", reason: `${this.mode} mode` };
    return { effect: "ask", reason: this.mode === "ask" ? "ask mode" : "ask before edits" };
  }
}

/** Hauptargument eines Aufrufs (für Muster). */
export function mainArgument(input: JSONValue | Record<string, unknown>): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["page_id", "database_id", "projectName", "projectID", "title", "query", "id"]) {
    if (typeof o[k] === "string") return o[k];
  }
  return undefined;
}
