// BSD-77: alte Swift-Transkripte übernehmen. Die Mac-App speicherte Chats und Sessions als Markdown mit
// `**Rolle**`-Überschriften im Seitentext (HappierStore.appendTranscript, gelesen von `TranscriptParser`,
// BasedBrain/Agent/Transcript.swift). Hier wird dieselbe Grammatik gelesen und in ChatEvents umgewandelt – lesbar,
// nicht verlustfrei (das alte Format hatte Tool-Eingaben, IDs und lange Ausgaben schon verworfen).
// Nicht-destruktiv: die alte Seite bleibt, der neue Chat merkt sich `importedFrom`.
import { isPageLike, isTrashed, MarkdownExporter, plainText, rowsOf, titleOf, type WorkspaceStore } from "@based/core";
import type { ChatEvent } from "./events.js";
import { ChatStore, chatMetaFrom, type ChatInfo } from "./transcript.js";

type LegacyKind = "user" | "agent" | "thought" | "tool" | "plan" | "notice" | "error" | "system" | "diff";

const ROLES: Record<string, LegacyKind> = {
  you: "user", user: "user", agent: "agent", assistant: "agent", thought: "thought", thinking: "thought",
  tool: "tool", "tool result": "tool", "tool failed": "tool", plan: "plan", notice: "notice", error: "error", system: "system", diff: "diff",
};

export interface LegacyItem {
  kind: LegacyKind;
  text: string;
  /** Tool-Aufrufe: „execute“, „Read“ … und ihre Ausgabe (aus dem folgenden „Tool result“). */
  toolKind?: string;
  output?: string;
  failed?: boolean;
}

const stripFence = (text: string): string => {
  if (!text.startsWith("```")) return text;
  const lines = text.split("\n");
  lines.shift();
  if (lines[lines.length - 1]?.startsWith("```")) lines.pop();
  return lines.join("\n");
};

/** Rollen-Zeile? Der Markdown-Export maskiert nichts in `**You**`, alte Dateien haben es wörtlich. */
function roleOf(line: string): string | undefined {
  const t = line.trim();
  if (!t.startsWith("**") || !t.endsWith("**") || t.length <= 4 || t.length >= 40) return undefined;
  const name = t.slice(2, -2);
  return ROLES[name.toLowerCase()] !== undefined ? name : undefined;
}

/** Swift `TranscriptParser.parse`. */
export function parseLegacyTranscript(markdown: string): LegacyItem[] {
  const items: LegacyItem[] = [];
  let role: string | undefined;
  let buf: string[] = [];
  const flush = () => {
    const lines = buf;
    buf = [];
    if (role === undefined) return;
    let text = lines.join("\n").trim();
    const key = role.toLowerCase();
    if (key === "tool result" || key === "tool failed") {
      text = stripFence(text);
      const open = items.findLast((x) => x.kind === "tool" && x.output === undefined);
      if (open) {
        open.output = text;
        open.failed = key === "tool failed";
      } else items.push({ kind: "tool", text: "Result", output: text, failed: key === "tool failed" });
      return;
    }
    const kind = ROLES[key]!;
    if (kind === "diff") {
      // „`pfad`\n```diff\n…\n```“ → text = Pfad, output = Diff
      const ls = text.split("\n");
      let path = ls[0] ?? "";
      if (path.startsWith("`") && path.endsWith("`") && path.length > 1) {
        path = path.slice(1, -1);
        ls.shift();
      } else path = "";
      if (ls[0]?.startsWith("```")) ls.shift();
      if (ls[ls.length - 1]?.startsWith("```")) ls.pop();
      items.push({ kind: "diff", text: path, output: ls.join("\n") });
      return;
    }
    if (kind === "tool") {
      // „`execute` Bash(ls)“
      let toolKind: string | undefined;
      const end = text.startsWith("`") ? text.indexOf("`", 1) : -1;
      if (end > 0) {
        toolKind = text.slice(1, end);
        text = text.slice(end + 1).trim();
      }
      items.push(toolKind === undefined ? { kind: "tool", text } : { kind: "tool", text, toolKind });
      return;
    }
    if (text === "") return;
    // Aufeinanderfolgende Agent-Stücke gehören zusammen.
    const last = items[items.length - 1];
    if (kind === "agent" && last?.kind === "agent") {
      last.text += "\n\n" + text;
      return;
    }
    items.push({ kind, text });
  };
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const name = roleOf(line);
    if (name !== undefined) {
      flush();
      role = name;
      continue;
    }
    buf.push(line);
  }
  flush();
  return items;
}

/** Alte Einträge → ChatEvents (jeder Turn endet mit `result`, Fehler mit `failed`). */
export function legacyToEvents(items: readonly LegacyItem[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  let open = false;
  let text = "";
  let n = 0;
  const close = () => {
    if (open) out.push({ type: "result", text, isError: false });
    open = false;
    text = "";
  };
  for (const item of items) {
    if (item.kind === "user") {
      close();
      out.push({ type: "userMessage", text: item.text });
      continue;
    }
    open = true;
    switch (item.kind) {
      case "agent":
        out.push({ type: "text", text: item.text });
        text = text ? text + "\n\n" + item.text : item.text;
        break;
      case "thought": out.push({ type: "thinking", text: item.text }); break;
      case "plan": out.push({ type: "text", text: "**Plan**\n\n" + item.text }); break;
      case "notice": case "system":
        out.push({ type: "notice", text: item.text.includes("```based-encrypted") ? "An encrypted entry could not be read." : item.text });
        break;
      case "error":
        out.push({ type: "failed", message: item.text });
        open = false;
        text = "";
        break;
      case "tool": case "diff": {
        n += 1;
        const id = "legacy-" + n;
        const name = item.kind === "diff" ? "Edit" : item.toolKind ?? "Tool";
        out.push({ type: "toolUse", id, name, input: item.kind === "diff" ? { path: item.text } : { title: item.text } });
        if (item.output !== undefined) out.push({ type: "toolResult", id, output: item.kind === "diff" ? "```diff\n" + item.output + "\n```" : item.output, isError: item.failed === true });
        break;
      }
    }
  }
  close();
  return out;
}

/** Sieht dieser Seitentext wie ein altes Transkript aus? (beginnt mit einer Rollen-Zeile) */
export function looksLikeLegacyTranscript(markdown: string): boolean {
  const first = markdown.split("\n").find((l) => l.trim() !== "");
  return first !== undefined && roleOf(first) !== undefined;
}

/** Seitentext ohne Titelzeile und ohne Properties-Kopf, als Markdown. */
function pageBody(store: WorkspaceStore, pageID: string): string {
  return new MarkdownExporter(store).export(pageID, false);
}

/** Alte Chat-/Session-Seiten: Zeilen der Datenbank „Sessions“ (Agent Brain der Mac-App), deren Text ein Transkript ist. */
export function findLegacyChats(store: WorkspaceStore): { pageID: string; title: string }[] {
  const out: { pageID: string; title: string }[] = [];
  for (const db of store.databases.values()) {
    if (plainText(db.title) !== "Sessions") continue;
    for (const row of rowsOf(store, db.id)) {
      if (row.trashedAt !== undefined || isTrashed(store, row.id)) continue;
      const body = pageBody(store, row.id);
      const start = body.split("\n").findIndex((l) => roleOf(l) !== undefined);
      if (start >= 0) out.push({ pageID: row.id, title: titleOf(store, row.id) });
    }
  }
  return out;
}

/**
 * Ein altes Transkript als neuen Chat übernehmen. Schon übernommene Seiten werden nicht doppelt angelegt.
 * `undefined`: die Seite enthält kein Transkript.
 */
export function importLegacyChat(chats: ChatStore, pageID: string): ChatInfo | undefined {
  const store = chats.store;
  if (!isPageLike(store.blocks.get(pageID))) return undefined;
  const existing = chats.list().find((c) => c.importedFrom === pageID);
  if (existing) return existing;
  const lines = pageBody(store, pageID).split("\n");
  const start = lines.findIndex((l) => roleOf(l) !== undefined);
  if (start < 0) return undefined;
  const events = legacyToEvents(parseLegacyTranscript(lines.slice(start).join("\n")));
  if (events.length === 0) return undefined;
  const title = titleOf(store, pageID) || chatMetaFrom(events).title || "Imported chat";
  const chat = chats.create({ title, importedFrom: pageID });
  chats.save(chat.id, 0, events);
  return chats.get(chat.id);
}

/** Alle alten Chats übernehmen; gibt die neu angelegten zurück. */
export function importLegacyChats(chats: ChatStore): ChatInfo[] {
  const have = new Set(chats.list().map((c) => c.importedFrom).filter((x): x is string => x !== undefined));
  const out: ChatInfo[] = [];
  for (const { pageID } of findLegacyChats(chats.store)) {
    if (have.has(pageID)) continue;
    const c = importLegacyChat(chats, pageID);
    if (c) out.push(c);
  }
  return out;
}
