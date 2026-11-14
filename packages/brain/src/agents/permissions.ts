// BSD-160 / BSD-50 + BSD-98 (Swift `AgentPermissions`, `PermissionLayers`): Berechtigungen wie in Claude Code –
// ein Modus (Composer-Pille: Ask / Ask before edits / Work freely) plus Regeln `allow|ask|deny Tool(muster)`,
// geschichtet global → Projekt → Agent. Vorrang: deny > ask > allow > Modus.
// Werkzeugnamen: die Chat-Werkzeuge als `based.<name>` (z. B. `based.create_page`), die Aktionen des Hauptagenten
// ebenso (`based.spawn_agent`, `based.file_to_project` …); `based.*` trifft alle. Das Muster prüft das Hauptargument
// (Seiten-ID, Projektname, Titel) als Glob (`*`, `?`, ohne Groß/Klein).
// BSD-245: Pfad-Regeln `Tool(path:Projekte/**)` prüfen den Seitenpfad des Ziels (Titel der Vorfahren mit „/“,
// wahlweise mit dem Bereich davor: `Private/…` bzw. der Teamspace-Name); `*` innerhalb eines Abschnitts, `**` über
// Abschnitte. Vorrang bleibt deny > ask > allow (sicher zuerst); unter Treffern gleicher Wirkung nennt der Grund die
// spezifischste Regel. Modus `plan`: nur lesen, Schreiben wird als Planschritt gesammelt (engine.ts).
import type { PermissionMode } from "../engine.js";
import { isPageLike, pageAncestors, sectionOf, titleOf, type JSONValue, type WorkspaceStore } from "@based/core";

export type PermissionEffect = "allow" | "ask" | "deny";

export interface PermissionRule {
  effect: PermissionEffect;
  tool: string;
  pattern?: string;
}

/** Art eines Aufrufs (wie Swift `ToolCategory`); ohne Angabe leitet `toolCategoryOf` sie aus Name und `write` ab. */
export type ToolCategory = "read" | "edit" | "destructive" | "shell" | "web" | "external";

export interface PermissionCall {
  tool: string;
  argument?: string | undefined;
  category?: ToolCategory | undefined;
  /** Shell: läuft in einer Sandbox (nur dann darf ein Modus sie ohne Rückfrage erlauben). */
  sandboxed?: boolean | undefined;
  /** BSD-245: Pfade der Zielseite (siehe `pagePathCandidates`); ohne: Pfad-Regeln greifen nicht. */
  paths?: readonly string[] | undefined;
}

export const PATH_PREFIX = "path:";

/** Pfad-Glob: `**` über Abschnitte, `*`/`?` innerhalb eines Abschnitts, ohne Groß/Klein, `/` am Rand egal. */
export function pathGlobMatch(pattern: string, path: string): boolean {
  const norm = (x: string) => x.trim().replace(/^\/+|\/+$/g, "").toLowerCase();
  let re = "";
  const pat = norm(pattern);
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]!;
    if (ch === "*" && pat[i + 1] === "*") {
      // „a/**“ trifft auch „a“ selbst; „**/b“ auch „b“.
      if (pat[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
      else if (re.endsWith("/")) { re = re.slice(0, -1) + "(?:/.*)?"; i += 1; }
      else { re += ".*"; i += 1; }
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$", "s").test(norm(path));
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
  if (["free", "workfreely", "bypass", "alloweverything", "bypasspermissions"].includes(k)) return "free";
  if (["plan", "planmode", "planfirst"].includes(k)) return "plan";
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

const SHELL_TOOLS = new Set(["bash", "shell", "execute"]);
const WEB_TOOLS = new Set(["webfetch", "websearch", "fetch", "web"]);

/** BSD-403 (Swift `PermissionRule.aliases`): Datei-Werkzeuge teilen `Edit`/`Write`-Regeln, `Web` deckt Abruf und Suche, `Bash` die Shell. */
export const TOOL_ALIASES: Readonly<Record<string, ReadonlySet<string>>> = {
  edit: new Set(["edit", "write", "multiedit", "notebookedit"]),
  write: new Set(["edit", "write", "multiedit", "notebookedit"]),
  web: WEB_TOOLS,
  bash: SHELL_TOOLS,
};

/** Art eines Aufrufs: angegeben, sonst aus dem Werkzeugnamen (Shell, Web, MCP = extern) und ob er etwas ändert. */
export function toolCategoryOf(call: PermissionCall, write = true): ToolCategory {
  if (call.category) return call.category;
  const t = call.tool.toLowerCase();
  if (SHELL_TOOLS.has(t)) return "shell";
  if (WEB_TOOLS.has(t)) return "web";
  if (!write) return "read";
  if (t.startsWith("mcp__") && !t.startsWith("mcp__based__")) return "external";
  return "edit";
}

const FOREVER = ["permanent", "empty_trash", "purge", "destroy", "delete_forever"];
const SENDS = ["send", "post", "publish", "email", "mail", "message", "tweet", "reply", "share", "invite", "transfer", "pay"];

/**
 * BSD-403 (Swift `PermissionCall.alwaysAsks`): nie durch den Modus allein erlaubt, nur durch eine ausdrückliche
 * allow-Regel – endgültig löschen, eine Inbox-Frage beantworten (entscheidet für den Nutzer, BSD-58), etwas nach
 * außen senden, Shell ohne Sandbox. Gibt den Grund zurück, sonst `undefined`.
 */
export function alwaysAsks(call: PermissionCall, write = true): string | undefined {
  const t = call.tool.toLowerCase();
  const cat = toolCategoryOf(call, write);
  if (t.endsWith("resolve_inbox")) return "answers an inbox item";
  if (FOREVER.some((w) => t.includes(w))) return "deletes for good";
  if (cat === "external" && SENDS.some((w) => t.includes(w))) return "sends something out";
  if (cat === "shell" && !call.sandboxed) return "shell outside a sandbox";
  return undefined;
}

export function ruleMatches(r: PermissionRule, call: PermissionCall): boolean {
  const name = call.tool.toLowerCase(), want = r.tool.toLowerCase();
  if (!(TOOL_ALIASES[want]?.has(name) ?? false) && !globMatch(want, name)) return false;
  if (r.pattern === undefined) return true;
  if (r.pattern.toLowerCase().startsWith(PATH_PREFIX)) {
    const pat = r.pattern.slice(PATH_PREFIX.length);
    return (call.paths ?? []).some((p) => pathGlobMatch(pat, p));
  }
  if (call.argument === undefined) return false;
  if (SHELL_TOOLS.has(name)) {
    // Claude Code: `cmd:*` = Präfix des Befehls an einer Wortgrenze (`git status:*` trifft nicht `git statusx`).
    const cmd = call.argument.trim();
    if (r.pattern.endsWith(":*")) {
      const prefix = r.pattern.slice(0, -2).trim();
      return cmd === prefix || cmd.startsWith(prefix + " ");
    }
    return globMatch(r.pattern, cmd);
  }
  return globMatch(r.pattern, call.argument);
}

/** Wie genau eine Regel ist (für den Grund): feste Zeichen im Muster, dann im Werkzeugnamen. */
const specificity = (r: PermissionRule) => (r.pattern ?? "").replace(/[*?]/g, "").length * 1000 + r.tool.replace(/[*?]/g, "").length;

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
      const same = hits.filter((h) => h.effect === e);
      if (same.length === 0) continue;
      const r = same.reduce((a, b) => (specificity(b) > specificity(a) ? b : a));
      return { effect: e, reason: `rule “${ruleText(r)}”` };
    }
    return undefined;
  }

  /** Urteil für einen Werkzeugaufruf: Regeln, sonst Modus (`write` = ändert etwas). */
  decide(call: PermissionCall, write: boolean): PermissionVerdict {
    const r = this.ruleVerdict(call);
    if (r) return r;
    if (!write) return { effect: "allow", reason: `${this.mode} mode` };
    if (this.mode === "free") {
      const why = alwaysAsks(call, write);
      return why ? { effect: "ask", reason: `always asks (${why})` } : { effect: "allow", reason: `${this.mode} mode` };
    }
    if (this.mode === "plan") return { effect: "deny", reason: "plan mode (recorded as a plan step)" };
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

/** Zielseite eines Aufrufs (für Pfad-Regeln): die Seite selbst oder die Elternseite, unter der etwas entsteht. */
export function targetPage(input: JSONValue | Record<string, unknown>): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ["page_id", "row_id", "parent_id", "block_id"]) if (typeof o[k] === "string" && o[k] !== "") return o[k];
  return undefined;
}

/**
 * Pfade einer Seite für Pfad-Regeln: Titel von oben nach unten mit „/“ (ohne Bereich) und dieselbe Kette mit dem
 * Bereich davor („Private/…“ oder der Teamspace-Name). Für einen Block die Seite, die ihn enthält. `[]` = unbekannt.
 */
export function pagePathCandidates(store: WorkspaceStore, id: string): string[] {
  let page = store.blocks.get(id);
  while (page && !isPageLike(page) && page.parent.startsWith("b:")) page = store.blocks.get(page.parent.slice(2));
  if (!page) return [];
  const chain = [...pageAncestors(store, page.id), page.id];
  const path = chain.map((x) => titleOf(store, x).replaceAll("/", "∕") || "Untitled").join("/");
  const top = store.blocks.get(chain[0]!);
  const section = top ? sectionOf(store, top) : { kind: "private" as const };
  const sectionName = section.kind === "teamspace" ? (store.workspace.teamspaces ?? []).find((t) => t.id === section.id)?.name ?? "Teamspace" : "Private";
  return [path, `${sectionName}/${path}`];
}
