// BSD-223: Freigabe-Inbox für Coding-Agenten. ACP fragt per `session/request_permission`; Based prüft zuerst die
// Berechtigungen (Modus + Regeln wie im Chat, BSD-160/245), und nur was „ask“ ergibt, landet in der Inbox. Die
// Inbox ist geräteneutral: Einträge sind reine Daten, `resolve` kommt von irgendeinem Gerät (lokal oder über den
// Server); bis dahin wartet der Agent. Abbruch der Sitzung räumt ihre offenen Fragen ab.
import type { JSONValue } from "@based/core";
import { Permissions, type PermissionCall } from "../agents/permissions.js";

/** ACP-Werkzeugarten (`ToolKind`). */
export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  /** `allow_once` | `allow_always` | `reject_once` | `reject_always` */
  kind: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCallId: string;
  title: string;
  kind: string;
  /** Hauptargument (Pfad, Befehl, URL) für Regeln und Anzeige. */
  argument: string | undefined;
  /** Eingabe gekürzt (2.000 Zeichen) für die Anzeige. */
  detail: string;
  options: AcpPermissionOption[];
}

export interface InboxItem extends AcpPermissionRequest {
  id: string;
  /** Anzeigename des Agenten („Claude Code“). */
  agent: string;
  createdAt: number;
}

/** Werkzeugarten, die nichts ändern. */
export const READ_ONLY_KINDS: ReadonlySet<string> = new Set(["read", "search", "think", "fetch"]);

/** Regel-Name einer ACP-Werkzeugart (Claude-Code-Stil: `Bash(npm *)`, `Edit(src/**)`, `Read`, `WebFetch`). */
export function ruleToolName(kind: string): string {
  switch (kind) {
    case "execute": return "Bash";
    case "edit": return "Edit";
    case "delete": return "Delete";
    case "move": return "Move";
    case "read": return "Read";
    case "search": return "Search";
    case "fetch": return "WebFetch";
    default: return kind === "" ? "Other" : kind[0]!.toUpperCase() + kind.slice(1);
  }
}

const str = (v: JSONValue | undefined) => (typeof v === "string" ? v : undefined);

/** Hauptargument aus `rawInput` bzw. `locations` eines ACP-Tool-Calls. */
export function toolCallArgument(toolCall: JSONValue | undefined): string | undefined {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return undefined;
  const raw = toolCall.rawInput;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of ["command", "file_path", "path", "url", "pattern", "query"]) {
      const v = raw[k];
      if (typeof v === "string" && v !== "") return v;
      if (k === "command" && Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").join(" ");
    }
  }
  const loc = Array.isArray(toolCall.locations) ? toolCall.locations[0] : undefined;
  if (loc && typeof loc === "object" && !Array.isArray(loc)) return str(loc.path);
  return undefined;
}

export type AutoDecision = { effect: "allow" | "deny"; optionId: string | undefined; reason: string } | { effect: "ask"; reason: string };

/**
 * Was die Berechtigungen ohne Rückfrage entscheiden. Bei „allow“/„deny“ wird die passende Option gewählt
 * (einmalig bevorzugt, „always“ nur, wenn es keine einmalige gibt) – fehlt eine passende, wird gefragt bzw.
 * abgebrochen.
 */
export function autoDecide(req: AcpPermissionRequest, permissions: Permissions): AutoDecision {
  const call: PermissionCall = { tool: ruleToolName(req.kind), argument: req.argument };
  const verdict = permissions.decide(call, !READ_ONLY_KINDS.has(req.kind));
  if (verdict.effect === "ask") return { effect: "ask", reason: verdict.reason };
  const prefer = verdict.effect === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  const opt = prefer.map((k) => req.options.find((o) => o.kind === k)).find((o) => o !== undefined);
  if (!opt && verdict.effect === "allow") return { effect: "ask", reason: verdict.reason };
  return { effect: verdict.effect, optionId: opt?.optionId, reason: verdict.reason };
}

type Listener = (items: readonly InboxItem[]) => void;

export class PermissionInbox {
  private readonly items = new Map<string, { item: InboxItem; settle: (optionId: string | undefined) => void }>();
  private readonly listeners = new Set<Listener>();
  private counter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Offene Fragen, älteste zuerst. */
  pending(): InboxItem[] {
    return [...this.items.values()].map((e) => e.item).sort((a, b) => a.createdAt - b.createdAt);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.pending());
    return () => this.listeners.delete(fn);
  }

  /** Frage stellen; das Versprechen liefert die gewählte `optionId` oder `undefined` (abgebrochen). */
  ask(agent: string, req: AcpPermissionRequest, signal?: AbortSignal): Promise<string | undefined> {
    const id = `perm-${++this.counter}`;
    return new Promise((resolve) => {
      if (signal?.aborted) { resolve(undefined); return; }
      const onAbort = () => this.settle(id, undefined);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.items.set(id, {
        item: { ...req, id, agent, createdAt: this.now() },
        settle: (o) => { signal?.removeEventListener("abort", onAbort); resolve(o); },
      });
      this.emit();
    });
  }

  /** Antwort von einem Gerät. Unbekannte Option zählt als Abbruch (der Agent bekommt nie eine erfundene ID). */
  resolve(id: string, optionId: string | undefined): boolean {
    const e = this.items.get(id);
    if (!e) return false;
    const valid = optionId !== undefined && e.item.options.some((o) => o.optionId === optionId) ? optionId : undefined;
    return this.settle(id, valid);
  }

  /** Bequem: erste Option der Art („allow_once“, „reject_once“ …). */
  resolveKind(id: string, kind: string): boolean {
    const e = this.items.get(id);
    if (!e) return false;
    return this.resolve(id, e.item.options.find((o) => o.kind === kind)?.optionId);
  }

  /** Alle offenen Fragen einer Sitzung abbrechen (Sitzung beendet oder Turn gestoppt). */
  cancelSession(sessionId: string): void {
    for (const [id, e] of [...this.items]) if (e.item.sessionId === sessionId) this.settle(id, undefined);
  }

  private settle(id: string, optionId: string | undefined): boolean {
    const e = this.items.get(id);
    if (!e) return false;
    this.items.delete(id);
    e.settle(optionId);
    this.emit();
    return true;
  }

  private emit(): void {
    const list = this.pending();
    for (const l of this.listeners) l(list);
  }
}

