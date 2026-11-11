// Das Erwähnungs-Menü hinter `@` und `[[`: Datum (Today, Tomorrow, getipptes Datum), Personen, Seitensuche über das
// Seitenverzeichnis der Shell (Volltextindex im Worker, wie Quick Find) und „New page“.
import type { DefaultReactSuggestionItem } from "@blocknote/react";
import { canonicalStringify, dateMentionValue, dateSuggestions } from "@based/core";
import { INLINE } from "../mapping/bn.js";
import type { BasedEditor } from "../schema/schema.js";
import { isEmojiIcon, type PageDirectory, type PageRef, type Person } from "./env.js";

export const MENTION_TRIGGERS = ["@", "[["] as const;

function insertMention(editor: BasedEditor, kind: string, value: string, text: string) {
  editor.insertInlineContent([{ type: INLINE.mention, props: { kind, value, text } } as never, " "], { updateSelection: true });
}

/** BSD-90 Teil 2: Text vor der Schreibmarke endet auf „[[Titel]“ (das zweite „]“ kommt gerade) → Titel, sonst nichts. */
export function wikilinkBefore(text: string): string | undefined {
  const m = /\[\[([^[\]\n]{1,200})\]$/.exec(text);
  const t = m?.[1]?.trim();
  return t ? t : undefined;
}

/**
 * „[[Titel]]“ fertig getippt (wie Obsidian): Seite mit genau diesem Titel erwähnen, sonst anlegen und erwähnen; ohne
 * Seitenverzeichnis bleibt der Text stehen.
 */
export async function resolveWikilink(editor: BasedEditor, title: string, opts: Pick<MentionMenuOptions, "pages" | "selfID">): Promise<"linked" | "created" | "text"> {
  const lower = title.toLowerCase();
  let found: PageRef[] = [];
  try {
    found = await opts.pages.search(title);
  } catch { /* Suche nicht erreichbar */ }
  const hit = found.find((p) => !p.trashed && !p.missing && (p.title || "").trim().toLowerCase() === lower);
  if (hit) {
    insertMention(editor, "page", hit.id, hit.title || title);
    return "linked";
  }
  const id = opts.pages.create ? await opts.pages.create(title).catch(() => undefined) : undefined;
  if (id) {
    insertMention(editor, "page", id, title);
    return "created";
  }
  editor.insertInlineContent([`[[${title}]]`] as never, { updateSelection: true });
  return "text";
}

const icon = (p: PageRef) => (isEmojiIcon(p.icon) ? p.icon : p.kind === "database" ? "▦" : "📄");

export interface MentionMenuOptions {
  pages: PageDirectory;
  people: readonly Person[];
  /** Seite des Editors: sie selbst wird nicht vorgeschlagen. */
  selfID: string;
  /** `[[` schlägt nur Seiten vor. */
  pagesOnly?: boolean;
  now?: () => Date;
}

export async function mentionItems(editor: BasedEditor, query: string, opts: MentionMenuOptions): Promise<DefaultReactSuggestionItem[]> {
  const q = query.trim();
  const lower = q.toLowerCase();
  const items: DefaultReactSuggestionItem[] = [];
  if (!opts.pagesOnly) {
    for (const d of dateSuggestions(q, (opts.now ?? (() => new Date()))())) {
      items.push({
        title: d.label, subtext: "Date", group: "Date", icon: <span aria-hidden>📅</span>,
        onItemClick: () => insertMention(editor, "date", canonicalStringify(dateMentionValue(d.date)), d.label),
      });
    }
    for (const p of opts.people) {
      if (lower !== "" && !p.name.toLowerCase().includes(lower)) continue;
      items.push({ title: p.name, subtext: "Person", group: "People", onItemClick: () => insertMention(editor, "user", p.id, p.name) });
    }
  }
  let found: PageRef[] = [];
  try {
    found = await opts.pages.search(q);
  } catch { /* Suche nicht erreichbar: nur Datum, Personen und „New page“ */ }
  for (const p of found) {
    if (p.trashed || p.missing || p.id === opts.selfID) continue;
    items.push({
      title: p.title || "Untitled", subtext: p.path ? p.path : p.kind === "database" ? "Database" : "Page", group: "Link to page",
      icon: <span aria-hidden>{icon(p)}</span>, onItemClick: () => insertMention(editor, "page", p.id, p.title || "Untitled"),
    });
  }
  const create = opts.pages.create;
  if (create && q !== "") {
    items.push({
      title: `New page “${q}”`, subtext: "Create a page and mention it", group: "New", icon: <span aria-hidden>＋</span>,
      onItemClick: () => {
        void create(q).then((id) => {
          if (id) insertMention(editor, "page", id, q);
        });
      },
    });
  }
  return items;
}
