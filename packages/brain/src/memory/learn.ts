// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Das Gedächtnis lernt von selbst (opt-in): nicht nur aus Chats (suggestions.ts), sondern aus dem, was der Nutzer
// schreibt und einspricht. Liegt eine geänderte Seite ein paar Minuten ruhig, liest das Chat-Modell sie einmal und
// legt höchstens drei dauerhafte Tatsachen als Memories ab; Heikles (Gesundheit, Geld) landet als „To review“ und
// zählt erst nach Freigabe. Dazu eine Memory „Writing style“ aus Schreibproben, und `personalContext`: was ein
// Schreib-Aufruf (Ask AI, ein Tastendruck im Text) über den Nutzer wissen soll.
// Hier nur reine Logik (Prompts, Auswahl, Budget, Zustand); der Ablauf steht in apps/web/src/brain/learner.ts.
import type { MemoryRecord } from "./suggestions.js";
import { normalizedWords } from "./suggestions.js";

/** Kürzere Seiten tragen nichts Dauerhaftes (Einkaufszettel, leere Vorlagen). */
export const LEARN_MIN_CHARS = 200;
/** So viel einer Seite geht höchstens an das Modell. */
export const LEARN_PAGE_CHARS = 6000;
/** Erst lernen, wenn die Seite so lange nicht mehr geändert wurde (niemand tippt mehr daran). */
export const LEARN_SETTLE_MS = 3 * 60_000;
/** Kam die Änderung über Sync, hat das Gerät, auf dem geschrieben wurde, zuerst Zeit zu lernen. */
export const LEARN_REMOTE_SETTLE_MS = 20 * 60_000;
/** Höchstens so viele Modellaufrufe je Stunde auf diesem Gerät (Kosten). */
export const LEARN_MAX_PER_HOUR = 12;
const HOUR = 3_600_000;
const MAX_PAGES = 500;

export const LEARN_SYSTEM = `You maintain the user's long-term memories for a notes app. Below is a note the USER wrote or dictated. Extract only durable facts about the user: who they are, their projects and goals, people they work with, their preferences and recurring routines. Skip one-off tasks, shopping lists, quotes, copied reference material and anything already in the existing memories. One topic per memory; title the topic, not the fact (e.g. "Project Based", "Morning routine"). Reuse an existing title when the fact extends it. Write each body in the language of the note. Mark health, medical, financial, legal or similarly private facts with "sensitive": true. At most 3. Reply with JSON only: {"memories": [{"title": "…", "type": "Profile|Preference|Work|People|Notes", "body": "one or two sentences", "sensitive": false}]} — or {"memories": []} when there is nothing worth keeping.`;

export function learnPrompt(page: { title: string; text: string }, existing: readonly MemoryRecord[]): string {
  const titles = existing.slice(0, 60).map((m) => `- ${m.title} (${m.kind})`).join("\n");
  return `Existing memories:\n${titles || "(none)"}\n\nNote “${page.title || "Untitled"}”:\n${page.text.slice(0, LEARN_PAGE_CHARS)}`;
}

/** FNV-1a (32 Bit) – nur um zu erkennen, ob sich der Text einer Seite seit dem letzten Lernen geändert hat. */
export function learnHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface LearnCandidate {
  id: string;
  title: string;
  text: string;
  /** Letzte Änderung am Inhalt (ms). */
  editedAt: number;
  /** Die Änderung kam von einem anderen Gerät. */
  remote?: boolean;
}

/** Zustand des Lernens auf diesem Gerät (localStorage): welche Fassung welcher Seite schon gelesen wurde. */
export interface LearnState {
  v: 1;
  pages: Record<string, { hash: string; at: number }>;
  /** Zeitpunkte der letzten Modellaufrufe (fürs Stundenbudget). */
  runs: number[];
  /** Die zuletzt bearbeiteten Seiten wurden beim Einschalten einmal vorgemerkt. */
  seeded?: boolean;
  style?: { hash: string; at: number };
}

export const emptyLearnState = (): LearnState => ({ v: 1, pages: {}, runs: [] });

export function parseLearnState(v: unknown): LearnState {
  if (v === null || typeof v !== "object") return emptyLearnState();
  const o = v as Partial<LearnState>;
  const pages: LearnState["pages"] = {};
  if (o.pages && typeof o.pages === "object") {
    for (const [id, p] of Object.entries(o.pages)) if (p && typeof p.hash === "string" && typeof p.at === "number") pages[id] = { hash: p.hash, at: p.at };
  }
  const style = o.style && typeof o.style.hash === "string" && typeof o.style.at === "number" ? { hash: o.style.hash, at: o.style.at } : undefined;
  return { v: 1, pages, runs: Array.isArray(o.runs) ? o.runs.filter((n): n is number => typeof n === "number") : [], ...(o.seeded === true ? { seeded: true } : {}), ...(style ? { style } : {}) };
}

export const learnBudgetLeft = (state: LearnState, now: number): number => LEARN_MAX_PER_HOUR - state.runs.filter((t) => now - t < HOUR).length;

/** Die nächste Seite, aus der gelernt wird: ruhig, lang genug, seit dem letzten Lesen geändert – die älteste zuerst. */
export function nextLearnPage(candidates: readonly LearnCandidate[], state: LearnState, now: number): LearnCandidate | undefined {
  if (learnBudgetLeft(state, now) <= 0) return undefined;
  return candidates
    .filter((c) => c.text.trim().length >= LEARN_MIN_CHARS && now - c.editedAt >= (c.remote ? LEARN_REMOTE_SETTLE_MS : LEARN_SETTLE_MS) && state.pages[c.id]?.hash !== learnHash(c.text))
    .sort((a, b) => a.editedAt - b.editedAt)[0];
}

/** Seiten, die nichts hergeben (zu kurz), als gelesen merken – sonst kämen sie jede Minute wieder. */
export function markLearned(state: LearnState, id: string, text: string, now: number, called = true): LearnState {
  const pages = { ...state.pages, [id]: { hash: learnHash(text), at: now } };
  const ids = Object.keys(pages);
  if (ids.length > MAX_PAGES) for (const old of ids.sort((a, b) => pages[a]!.at - pages[b]!.at).slice(0, ids.length - MAX_PAGES)) delete pages[old];
  return { ...state, pages, runs: called ? [...state.runs.filter((t) => now - t < HOUR), now] : state.runs };
}

// MARK: Schreibstil

export const STYLE_TITLE = "Writing style";
/** Darunter lässt sich kein Stil ablesen. */
export const STYLE_MIN_CHARS = 1500;
export const STYLE_SAMPLE_CHARS = 6000;
export const STYLE_REFRESH_MS = 7 * 24 * HOUR;

export const STYLE_SYSTEM = `Below are samples of the user's own writing from their notes. Describe how this person writes so that another writer could imitate them: language(s), tone, sentence length, vocabulary, typical phrases, punctuation and formatting habits, how they open and close a text. Six short bullet points at most, as plain Markdown bullets, no preamble. Describe the style only – repeat no facts or names from the samples.`;

export const stylePrompt = (samples: string): string => `Writing samples:\n\n${samples.slice(0, STYLE_SAMPLE_CHARS)}`;

/** Stil (neu) ablesen: genug Text, seit dem letzten Mal geändert und eine Woche her (oder noch nie). */
export function styleDue(state: LearnState, samples: string, now: number): boolean {
  if (samples.trim().length < STYLE_MIN_CHARS || learnBudgetLeft(state, now) <= 0) return false;
  if (!state.style) return true;
  return now - state.style.at >= STYLE_REFRESH_MS && state.style.hash !== learnHash(samples);
}

export const markStyle = (state: LearnState, samples: string, now: number): LearnState =>
  ({ ...state, style: { hash: learnHash(samples), at: now }, runs: [...state.runs.filter((t) => now - t < HOUR), now] });

/** Antwort säubern: höchstens sechs Stichpunkte, nichts drumherum. */
export function parseStyle(answer: string): string {
  const lines = answer.split("\n").map((l) => l.trim()).filter((l) => /^[-*•]\s+\S/.test(l)).map((l) => "- " + l.replace(/^[-*•]\s+/, "").slice(0, 240));
  return lines.slice(0, 6).join("\n");
}

// MARK: Was ein Schreib-Aufruf über den Nutzer weiß

export const PERSONAL_CONTEXT_CHARS = 2400;
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "der", "die", "das", "und", "ein", "eine", "mit", "für", "von", "ist", "auf", "den", "dem", "zu", "in", "to", "of", "a", "an", "is", "it"]);
const words = (s: string) => normalizedWords(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w));

/** Memories nach gemeinsamen Wörtern mit der Anfrage (Titel zählt doppelt); ohne Treffer keine. */
export function relevantMemories(memories: readonly MemoryRecord[], query: string, limit = 5): MemoryRecord[] {
  const q = new Set(words(query));
  if (q.size === 0) return [];
  return memories
    .map((m) => {
      let score = 0;
      for (const w of new Set(words(m.title))) if (q.has(w)) score += 2;
      for (const w of new Set(words(m.body))) if (q.has(w)) score += 1;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

/** Zeilen wie „About: …“/„Source: …“ sind Verknüpfungen, kein Wissen. */
const factText = (body: string) => body.split("\n").filter((l) => !/^(About|Source|Replaces):\s/.test(l.trim())).join("\n").trim();

/**
 * Zusatz zum System-Prompt eines Schreib-Aufrufs: wer der Nutzer ist („About me“), wie er schreibt („Writing
 * style“) und was zur Anfrage passt. Leer, wenn es nichts gibt. `memories` sind die aktiven (nie „To review“).
 */
export function personalContext(input: { about: string; memories: readonly MemoryRecord[]; query: string }): string {
  const style = input.memories.find((m) => normalizedWords(m.title) === normalizedWords(STYLE_TITLE));
  const others = input.memories.filter((m) => m !== style);
  const profile = others.filter((m) => m.kind === "Profile").slice(0, 3);
  const picked = [...new Set([...relevantMemories(others, input.query), ...profile])].slice(0, 6);
  // „About me“ zählt nur, wenn unter den Überschriften der Vorlage etwas steht.
  const about = input.about.split("\n").some((l) => l.trim() && !l.trim().startsWith("#")) ? input.about.trim() : "";
  const parts: string[] = [];
  if (style && factText(style.body)) parts.push(`How the user writes – match this voice unless the instruction asks for another:\n${factText(style.body)}`);
  if (about) parts.push(`About the user:\n${about.slice(0, 800)}`);
  if (picked.length) parts.push(`What you know about the user (use only where it helps, never mention that you were given it):\n${picked.map((m) => `- ${m.title}: ${factText(m.body).replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`);
  return parts.join("\n\n").slice(0, PERSONAL_CONTEXT_CHARS);
}
