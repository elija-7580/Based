// BSD-206: Wortzahl einer Seite und Suchen in der Seite (⌘F) als reine Funktionen. Ohne Intl.Segmenter: der System-ICU in
// WKWebView scheitert daran unter Speicherdruck (BSD-253).
import { plainText } from "../richtext.js";
import { subtree } from "../store/pages.js";
import type { WorkspaceStore } from "../store/store.js";

export interface TextStats {
  words: number;
  /** Zeichen (Codepunkte) ohne Zeilenumbrüche. */
  characters: number;
}

const WORD = /[\p{L}\p{N}]+(?:['’.\-_][\p{L}\p{N}]+)*/gu;
// Schriften ohne Leerzeichen zwischen Wörtern: jedes Zeichen zählt als Wort (wie Notion und die meisten Editoren).
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/gu;

export function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = cjk ? text.replace(CJK, " ") : text;
  return cjk + (rest.match(WORD)?.length ?? 0);
}

export function textStats(texts: Iterable<string>): TextStats {
  let words = 0, characters = 0;
  for (const t of texts) {
    if (!t) continue;
    words += countWords(t);
    for (const ch of t) if (ch !== "\n" && ch !== "\r") characters += 1;
  }
  return { words, characters };
}

/** Wörter und Zeichen im Inhalt einer Seite (ohne Titel, ohne Unterseiten und Datenbankzeilen). */
export function pageTextStats(store: WorkspaceStore, pageID: string): TextStats {
  const texts: string[] = [];
  const skip = new Set<string>();
  for (const id of subtree(store, pageID, false)) {
    const b = store.blocks.get(id);
    if (!b || b.trashedAt !== undefined) continue;
    // Inhalt von Unterseiten gehört zu deren Seite.
    const parent = b.parent.startsWith("b:") ? b.parent.slice(2) : undefined;
    if (parent !== undefined && skip.has(parent)) {
      skip.add(id);
      continue;
    }
    if (b.type === "page" || b.type === "databasePage") {
      skip.add(id);
      continue;
    }
    texts.push(plainText(b.text));
    if (b.props?.cells) for (const c of b.props.cells) texts.push(plainText(c));
    if (b.props?.caption !== undefined) texts.push(plainText(b.props.caption));
  }
  return textStats(texts);
}

export interface TextMatch {
  start: number;
  end: number;
}

const foldChar = (ch: string) => ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replaceAll("ß", "ss");

/** Text für die Suche falten (Groß/klein, Akzente, ß) und zu jeder gefalteten Stelle die Stelle im Original merken. */
export function foldWithMap(text: string): { folded: string; starts: Uint32Array; ends: Uint32Array } {
  let folded = "";
  const starts: number[] = [], ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = ch.charCodeAt(0) < 128 ? ch.toLowerCase() : foldChar(ch);
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    folded += f;
    i += ch.length;
  }
  return { folded, starts: Uint32Array.from(starts), ends: Uint32Array.from(ends) };
}

/**
 * Alle Fundstellen von `query` in `text`, ohne Überlappung; Groß/klein, Akzente und ß/ss sind egal. Stellen im Original.
 * `limit` deckelt die Trefferzahl (lange Seiten, ein Buchstabe als Suche).
 */
export function findInText(text: string, query: string, limit = 10_000): TextMatch[] {
  const q = foldWithMap(query).folded;
  if (!q || !text) return [];
  const { folded, starts, ends } = foldWithMap(text);
  const out: TextMatch[] = [];
  for (let at = folded.indexOf(q); at >= 0 && out.length < limit; at = folded.indexOf(q, at + q.length)) {
    out.push({ start: starts[at]!, end: ends[at + q.length - 1]! });
  }
  return out;
}
