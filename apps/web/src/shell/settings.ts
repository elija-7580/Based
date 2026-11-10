// Einstellungen: Modell (Seiten wie in der Swift-Vorlage SettingsView.swift), Registry für Abschnitte und die
// Prüfung des Sync-Formulars. Ohne React – die Ansicht (screens/Settings.tsx) bleibt dünn.
// Andere Bereiche hängen ihren Abschnitt ein, ohne Settings.tsx anzufassen:
//   registerSettingsSection({ id: "ai-keys", page: "agents", title: "API keys", component: AIKeys, provides: ["API keys"] })
import type { SyncConfig } from "../worker/protocol.js";

export type SettingsGroup = "account" | "workspace";

export interface SettingsPageDef {
  id: string;
  title: string;
  group: SettingsGroup;
  /** Ein Satz unter dem Seitentitel. */
  summary: string;
  /** Was die Swift-App hier kann und Based Next noch nicht – wird ehrlich als „Not available yet“ gezeigt. */
  missing: readonly string[];
}

export const SETTINGS_GROUPS: readonly { id: SettingsGroup; title: string }[] = [
  { id: "account", title: "Account" },
  { id: "workspace", title: "Workspace" },
];

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  { id: "account", group: "account", title: "My account", summary: "This device and how it stores your workspace.", missing: ["Preferred name and initials", "Based server account (email, password)", "Delete account"] },
  { id: "my-settings", group: "account", title: "My settings", summary: "Changes apply to the whole app — try them, then click around.", missing: ["Home page and start page", "Default font, small text and full width for new pages", "Spell-check", "Meeting voices", "Semantic search", "Quick capture"] },
  { id: "notifications", group: "account", title: "My notifications", summary: "Where Based tells you that an agent needs you.", missing: ["Push notifications", "Agent approvals in the Inbox", "Email digests"] },
  { id: "my-connections", group: "account", title: "My connections", summary: "Accounts and tools connected for you.", missing: ["Connected accounts", "Slack notifications"] },
  { id: "language", group: "account", title: "Language & region", summary: "Language, week start, dates and time.", missing: ["App language", "Start week on Monday", "Timezone", "Date and time format"] },
  { id: "workspace", group: "workspace", title: "General", summary: "What is in this workspace, and how to take it with you.", missing: ["Workspace icon", "Clear undo history", "Reset workspace"] },
  { id: "people", group: "workspace", title: "People", summary: "Members and guests of this workspace.", missing: ["Members", "Invitations", "Guests"] },
  { id: "teamspaces", group: "workspace", title: "Teamspaces", summary: "Shared areas of the workspace.", missing: ["Default teamspace", "Who may create teamspaces"] },
  { id: "security", group: "workspace", title: "Security", summary: "Access to the app and to your data.", missing: ["App lock (Face ID / Touch ID)", "Export and guest rules", "Agent approval rules"] },
  { id: "agents", group: "workspace", title: "Agents & AI", summary: "Models, keys and what agents may do.", missing: ["API keys for AI providers", "Agents and the main agent", "Permissions", "Skills", "Sandbox cleanup"] },
  { id: "connections", group: "workspace", title: "Connections", summary: "MCP servers and other tools agents can use.", missing: ["MCP connections", "Tool permissions"] },
  { id: "import", group: "workspace", title: "Import", summary: "Bring in a Notion export or Markdown files, or take everything with you.", missing: [] },
  { id: "sync", group: "workspace", title: "Sync & server", summary: "Use your workspace on your other devices.", missing: ["iCloud sync"] },
  { id: "billing", group: "workspace", title: "Billing", summary: "Based is open source and free.", missing: ["AI usage overview"] },
  { id: "updates", group: "workspace", title: "Updates", summary: "How this copy of Based stays current.", missing: ["Update channel", "Automatic update checks on or off"] },
  { id: "diagnostics", group: "workspace", title: "Diagnostics", summary: "What the app knows about its own state.", missing: ["Logs", "Hang reports", "Layout audit", "Command-line tool"] },
  { id: "about", group: "workspace", title: "About", summary: "Based Next — the notes app that keeps your data yours.", missing: [] },
];

export const DEFAULT_SETTINGS_PAGE = "my-settings";

/** Seite zu einer ID aus Route/Hash; Unbekanntes fällt auf „My settings“ (Darstellung) zurück. */
export function resolveSettingsPage(id: string | undefined, pages: readonly SettingsPageDef[] = SETTINGS_PAGES): SettingsPageDef {
  return pages.find((p) => p.id === id) ?? pages.find((p) => p.id === DEFAULT_SETTINGS_PAGE) ?? pages[0]!;
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
  sectionsFor(pageID: string): SettingsSection<C>[] {
    return [...this.sections.values()]
      .filter((e) => e.section.page === pageID)
      .sort((a, b) => (a.section.order ?? 100) - (b.section.order ?? 100) || a.seq - b.seq)
      .map((e) => e.section);
  }

  /** Was auf der Seite noch fehlt, nach Abzug dessen, was angemeldete Abschnitte liefern. */
  missingFor(pageID: string): string[] {
    const page = this.pages.find((p) => p.id === pageID);
    if (!page) return [];
    const provided = new Set(this.sectionsFor(pageID).flatMap((s) => s.provides ?? []));
    return page.missing.filter((m) => !provided.has(m));
  }

  status(pageID: string): PageStatus {
    const has = this.sectionsFor(pageID).length > 0;
    const missing = this.missingFor(pageID).length > 0;
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
