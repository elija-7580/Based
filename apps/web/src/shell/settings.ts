// Einstellungen: Modell (Gruppen und Seiten), Registry für Abschnitte, die Suche und die Prüfung des
// Sync-Formulars. Ohne React – die Ansicht (screens/Settings.tsx) bleibt dünn.
// Andere Bereiche hängen ihren Abschnitt ein, ohne Settings.tsx anzufassen:
//   registerSettingsSection({ id: "ai-keys", page: "agents", title: "API keys", component: AIKeys, provides: ["API keys"] })
import type { SyncConfig } from "../worker/protocol.js";
import { productName } from "./beta.js";

/** Elija 18.11.: drei Gruppen statt Notions „Account / Workspace“ – App (dieses Gerät, wie es aussieht und schreibt), Workspace (die Daten), System. */
export type SettingsGroup = "app" | "workspace" | "system";

export interface SettingsPageDef {
  id: string;
  title: string;
  group: SettingsGroup;
  /** Ein Satz unter dem Seitentitel. */
  summary: string;
  /** Was die Swift-App hier kann und Based Next noch nicht – wird ehrlich als „Not available yet“ gezeigt. */
  missing: readonly string[];
  /**
   * AI-Schalter (shell/ai.ts): „page“ = die ganze Seite gibt es nur mit AI; „missing“ = nur die Liste „Not available
   * yet“ (sie nennt dann nur AI-Funktionen) fällt ohne AI weg.
   */
  ai?: "page" | "missing";
}

/** Was die Ansicht über den AI-Schalter weiß; fehlt `ai`, gilt an. */
export interface SettingsViewOpts { ai?: boolean }

/** Seiten, die gerade erscheinen (ohne AI fallen reine AI-Seiten weg). */
export const visibleSettingsPages = (pages: readonly SettingsPageDef[], opts: SettingsViewOpts = {}) =>
  pages.filter((p) => opts.ai !== false || p.ai !== "page");

export const SETTINGS_GROUPS: readonly { id: SettingsGroup; title: string }[] = [
  { id: "app", title: "App" },
  { id: "workspace", title: "Workspace" },
  { id: "system", title: "System" },
];

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  { id: "appearance", group: "app", title: "Appearance", summary: "Theme, font and density. Changes apply right away.", missing: [] },
  { id: "editor", group: "app", title: "Pages", summary: "What opens first, and how new pages start.", missing: ["Semantic search", "Quick capture"] },
  { id: "meetings", group: "app", title: "Meeting notes", summary: "Recording and transcription on this device.", missing: ["Meeting voices"] },
  { id: "language", group: "app", title: "Language & region", summary: "Language, week start, dates and time.", missing: ["App language", "Start week on Monday", "Timezone", "Date and time format"] },
  { id: "notifications", group: "app", title: "Notifications", summary: "Where Based tells you that an agent needs you.", missing: ["Push notifications", "Agent approvals in the Inbox", "Email digests"] },
  { id: "my-connections", group: "app", title: "Connected accounts", summary: "Accounts and tools connected for you.", missing: ["Connected accounts", "Slack notifications"] },
  { id: "workspace", group: "workspace", title: "General", summary: "What is in this workspace, and how to take it with you.", missing: ["Workspace icon", "Clear undo history", "Reset workspace"] },
  { id: "people", group: "workspace", title: "People", summary: "Members and guests of this workspace.", missing: ["Members", "Invitations", "Guests"] },
  { id: "teamspaces", group: "workspace", title: "Teamspaces", summary: "Shared areas of the workspace.", missing: ["Default teamspace", "Who may create teamspaces"] },
  { id: "security", group: "workspace", title: "Security", summary: "Access to the app and to your data.", missing: ["App lock (Face ID / Touch ID)", "Export and guest rules", "Agent approval rules"] },
  { id: "agents", group: "workspace", title: "Agents & AI", summary: "AI features, skills and memories.", ai: "missing", missing: ["API keys for AI providers", "Agents and the main agent", "Permissions", "Skills", "Sandbox cleanup"] },
  { id: "connections", group: "workspace", title: "Connections", summary: "MCP servers and other tools agents can use.", ai: "page", missing: ["MCP connections", "Tool permissions"] },
  { id: "import", group: "workspace", title: "Import", summary: "Bring in a Notion export or Markdown files, or take everything with you.", missing: [] },
  { id: "sync", group: "workspace", title: "Sync & server", summary: "Use your workspace on your other devices.", missing: [] },
  { id: "billing", group: "workspace", title: "Billing", summary: "Based is free during the beta. Donations keep it running.", ai: "missing", missing: ["AI usage overview"] },
  { id: "account", group: "system", title: "This device", summary: "This device and how it stores your workspace.", missing: ["Preferred name and initials", "Based server account (email, password)", "Delete account"] },
  { id: "ai-apps", group: "system", title: "Connect AI apps", summary: "Use Based from Claude Code, Claude Desktop, Cursor and other MCP apps.", missing: [] },
  { id: "updates", group: "system", title: "Updates", summary: "How this copy of Based stays current.", missing: [] },
  { id: "diagnostics", group: "system", title: "Diagnostics", summary: "What the app knows about its own state.", missing: ["Logs", "Hang reports", "Layout audit"] },
  { id: "about", group: "system", title: "About", summary: `${productName()} — the notes app that keeps your data yours.`, missing: [] },
];

export const DEFAULT_SETTINGS_PAGE = "appearance";

/** Alte Links und Lesezeichen: „My settings“ gibt es nicht mehr, sein Inhalt beginnt jetzt mit Appearance. */
const PAGE_ALIASES: Readonly<Record<string, string>> = { "my-settings": "appearance" };

/** Seite zu einer ID aus Route/Hash; Unbekanntes fällt auf „Appearance“ zurück. */
export function resolveSettingsPage(id: string | undefined, pages: readonly SettingsPageDef[] = SETTINGS_PAGES): SettingsPageDef {
  const wanted = id !== undefined ? PAGE_ALIASES[id] ?? id : undefined;
  return pages.find((p) => p.id === wanted) ?? pages.find((p) => p.id === DEFAULT_SETTINGS_PAGE) ?? pages[0]!;
}

export interface SettingsSection<C = unknown> {
  /** Eindeutig; ein zweites `register` mit derselben ID ersetzt den Abschnitt. */
  id: string;
  title: string;
  /** Seite, auf der der Abschnitt erscheint (ID aus SETTINGS_PAGES). Standard: „workspace“. */
  page?: string;
  description?: string;
  /** Kleinere Zahl = weiter oben; Standard 100. Gleiche Zahl: Reihenfolge der Anmeldung. */
  order?: number;
  /** Einträge aus `missing` der Seite, die dieser Abschnitt jetzt liefert (verschwinden aus „Not available yet“). */
  provides?: readonly string[];
  /** AI-Schalter: nur mit eingeschalteter AI zeigen (Modelle, Hauptagent, Privacy-Redact, MCP-Connections …). */
  ai?: boolean;
  /**
   * Wonach man sucht, um hier zu landen (Suchfeld der Einstellungen): die Namen der Einstellungen im Abschnitt und
   * Wörter, die Leute dafür benutzen („dark mode“ für Theme). Nur nennen, was der Abschnitt in diesem Kanal zeigt.
   */
  keywords?: readonly string[];
  component: C;
}

export type PageStatus = "available" | "partial" | "unavailable";

/** Registry der Einstellungs-Abschnitte. Generisch im Komponententyp, damit sie ohne React testbar ist. */
export class SettingsRegistry<C = unknown> {
  private sections = new Map<string, { section: SettingsSection<C>; seq: number }>();
  private listeners = new Set<() => void>();
  private seq = 0;
  private version = 0;

  constructor(private readonly pages: readonly SettingsPageDef[] = SETTINGS_PAGES) {}

  /** Meldet einen Abschnitt an; die Rückgabe meldet ihn wieder ab. Unbekannte Seite → Fehler (Tippfehler früh sehen). */
  register = (section: SettingsSection<C>): (() => void) => {
    const page = section.page ?? "workspace";
    if (!this.pages.some((p) => p.id === page)) throw new Error(`Unknown settings page: ${page}`);
    if (!section.id.trim() || !section.title.trim()) throw new Error("A settings section needs an id and a title");
    const entry = { section: { ...section, page }, seq: this.sections.get(section.id)?.seq ?? this.seq++ };
    this.sections.set(section.id, entry);
    this.changed();
    return () => {
      if (this.sections.get(section.id) === entry) {
        this.sections.delete(section.id);
        this.changed();
      }
    };
  };

  /** Abschnitte einer Seite in Anzeigereihenfolge. */
  sectionsFor(pageID: string, opts: SettingsViewOpts = {}): SettingsSection<C>[] {
    return [...this.sections.values()]
      .filter((e) => e.section.page === pageID && (opts.ai !== false || !e.section.ai))
      .sort((a, b) => (a.section.order ?? 100) - (b.section.order ?? 100) || a.seq - b.seq)
      .map((e) => e.section);
  }

  /** Was auf der Seite noch fehlt, nach Abzug dessen, was angemeldete Abschnitte liefern. */
  missingFor(pageID: string, opts: SettingsViewOpts = {}): string[] {
    const page = this.pages.find((p) => p.id === pageID);
    if (!page || (opts.ai === false && page.ai)) return [];
    const provided = new Set(this.sectionsFor(pageID, opts).flatMap((s) => s.provides ?? []));
    return page.missing.filter((m) => !provided.has(m));
  }

  status(pageID: string, opts: SettingsViewOpts = {}): PageStatus {
    const has = this.sectionsFor(pageID, opts).length > 0;
    const missing = this.missingFor(pageID, opts).length > 0;
    return has ? (missing ? "partial" : "available") : "unavailable";
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Ändert sich bei jeder An-/Abmeldung (für useSyncExternalStore). */
  getVersion = (): number => this.version;

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

// MARK: Suche

export interface SettingsHit {
  /** Seite, die geöffnet wird. */
  page: string;
  /** Abschnitt auf der Seite, zu dem gerollt wird (fehlt bei einem Treffer auf die Seite selbst). */
  section?: string;
  /** Was in der Trefferliste steht: die Einstellung, der Abschnitt oder die Seite. */
  label: string;
  /** Zweite Zeile: wo der Treffer liegt („Appearance“, „Sync & server · Backups“). */
  where: string;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Höchstens ein Tippfehler (ersetzt, fehlt, zu viel, vertauscht) – nur für Wörter ab vier Zeichen und nur, wenn der
 * erste Buchstabe stimmt (sonst findet „font“ auch „content“).
 */
function nearly(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || a[0] !== b[0] || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ra = a.slice(i), rb = b.slice(i);
  return ra.slice(1) === rb.slice(1) || ra.slice(1) === rb || ra === rb.slice(1) || (ra.length > 1 && rb.length > 1 && ra[0] === rb[1] && ra[1] === rb[0] && ra.slice(2) === rb.slice(2));
}

/** 3 = Wort beginnt so, 2 = steht im Wort, 1 = bis auf einen Tippfehler, 0 = passt nicht. */
function wordScore(q: string, words: readonly string[]): number {
  let best = 0;
  for (const w of words) {
    if (w.startsWith(q)) return 3;
    if (q.length >= 3 && w.includes(q)) best = Math.max(best, 2);
    // Tippfehler im Wortanfang erst ab fünf Zeichen – sonst findet „calm“ den „Calendar“.
    else if (nearly(q, w) || (q.length >= 5 && nearly(q, w.slice(0, q.length)))) best = Math.max(best, 1);
  }
  return best;
}

/** Jedes Wort der Anfrage muss im Text vorkommen; die Zahl sagt, wie gut. */
function textScore(query: readonly string[], text: string): number {
  const words = norm(text).split(" ").filter(Boolean);
  let sum = 0;
  for (const q of query) {
    const s = wordScore(q, words);
    if (!s) return 0;
    sum += s;
  }
  return sum / query.length;
}

/**
 * Suche in den Einstellungen: Seiten (Titel, Satz darunter), Abschnitte (Titel, Beschreibung) und deren Stichwörter.
 * Verzeiht einen Tippfehler pro Wort. Nur was `pages`/`opts` gerade zeigen (Beta-Kanal, AI-Schalter) wird gefunden.
 */
export function searchSettings<C>(query: string, pages: readonly SettingsPageDef[], registry: SettingsRegistry<C>, opts: SettingsViewOpts = {}, limit = 8): SettingsHit[] {
  const q = norm(query).split(" ").filter(Boolean);
  if (!q.length) return [];
  const hits: { hit: SettingsHit; score: number; order: number }[] = [];
  let order = 0;
  const add = (hit: SettingsHit, score: number) => { if (score > 0) hits.push({ hit, score, order: order++ }); };
  for (const p of pages) {
    add({ page: p.id, label: p.title, where: "Page" }, textScore(q, p.title) * 1.2 || textScore(q, p.summary) * 0.5);
    for (const s of registry.sectionsFor(p.id, opts)) {
      const where = s.title === p.title ? p.title : `${p.title} · ${s.title}`;
      if (s.title !== p.title) add({ page: p.id, section: s.id, label: s.title, where: p.title }, textScore(q, s.title) * 1.1 || textScore(q, s.description ?? "") * 0.5);
      for (const k of s.keywords ?? []) add({ page: p.id, section: s.id, label: k, where }, textScore(q, k));
    }
  }
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  // je Abschnitt nur der beste Treffer – sonst füllt ein Abschnitt mit vielen Stichwörtern die ganze Liste
  const seen = new Set<string>();
  const out: SettingsHit[] = [];
  for (const { hit } of hits) {
    const key = hit.page + "/" + (hit.section ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

export type SyncFormResult = { ok: true; config: SyncConfig } | { ok: false; field: "url"; error: string };

/** Prüft die Eingabe im Sync-Formular: http(s)-Adresse, Leerzeichen ab; das Token darf leer sein. */
export function validateSyncForm(input: { url: string; token: string }): SyncFormResult {
  const raw = input.url.trim();
  if (!raw) return { ok: false, field: "url", error: "Enter the address of your based-server." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, field: "url", error: "This doesn't look like an address. It should start with https://" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, field: "url", error: "The address must start with https:// or http://" };
  if (url.username || url.password) return { ok: false, field: "url", error: "Leave the token out of the address and put it in the Token field." };
  return { ok: true, config: { url: raw.replace(/\/+$/, ""), token: input.token.trim() } };
}
