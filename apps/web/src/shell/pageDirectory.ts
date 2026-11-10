// Seitenverzeichnis für den Editor (@based/editor PageDirectory): Titel, Icon und Papierkorb-Zustand beliebiger
// Seiten für Erwähnungen, plus Seitensuche und „New page“ fürs @-Menü. Die Daten liegen im Store-Worker; hier ist
// nur ein kleiner Zwischenspeicher, der sich auffrischt, wenn sich Titel oder Seitenstruktur ändern.
import type { PageDirectory, PageRef } from "@based/editor";
import type { StoreClient } from "../worker/client.js";
import type { PageInfo } from "../worker/protocol.js";
import { recentPages } from "./storage.js";

const toRef = (p: PageInfo): PageRef => ({ id: p.id, title: p.title, icon: p.icon, kind: p.kind, path: p.path, trashed: p.trashed });
const same = (a: PageRef | undefined, b: PageRef) =>
  a !== undefined && a.title === b.title && a.icon === b.icon && a.trashed === b.trashed && a.missing === b.missing && a.kind === b.kind;

export class ShellPageDirectory implements PageDirectory {
  private cache = new Map<string, PageRef>();
  private wanted = new Set<string>();
  private listeners = new Set<() => void>();
  private queued = false;
  private unsubscribe: (() => void) | undefined;
  private seen: { titles: unknown; outline: unknown } = { titles: undefined, outline: undefined };

  constructor(private readonly client: StoreClient) {}

  get = (id: string): PageRef | undefined => {
    if (id === "") return undefined;
    const hit = this.cache.get(id);
    if (hit) return hit;
    this.want(id);
    // Bis der Worker antwortet: der Titel aus der Titel-Tabelle der Shell (Papierkorb noch unbekannt).
    const state = this.client.getState();
    const title = state.titles.get(id);
    if (title === undefined) return undefined;
    return { id, title, icon: state.outline?.nodes[id]?.icon };
  };

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    if (!this.unsubscribe) {
      const s = this.client.getState();
      this.seen = { titles: s.titles, outline: s.outline };
      // Titel oder Struktur (Icon, Papierkorb, verschoben) haben sich geändert: alles Bekannte neu fragen.
      this.unsubscribe = this.client.subscribe(() => {
        const now = this.client.getState();
        if (now.titles === this.seen.titles && now.outline === this.seen.outline) return;
        this.seen = { titles: now.titles, outline: now.outline };
        for (const id of this.cache.keys()) this.want(id);
      });
    }
    return () => {
      this.listeners.delete(onChange);
      if (this.listeners.size === 0) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    };
  };

  private want(id: string) {
    this.wanted.add(id);
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => void this.fetch());
  }

  private async fetch() {
    this.queued = false;
    const ids = [...this.wanted];
    this.wanted.clear();
    if (ids.length === 0) return;
    let infos: Record<string, PageInfo | null>;
    try {
      infos = await this.client.pageInfo(ids);
    } catch {
      return; // Store nicht bereit: beim nächsten Wechsel von Titeln/Struktur wieder
    }
    let changed = false;
    for (const id of ids) {
      const info = infos[id];
      const next: PageRef = info ? toRef(info) : { id, title: "", missing: true };
      if (!same(this.cache.get(id), next)) {
        this.cache.set(id, next);
        changed = true;
      }
    }
    if (changed) for (const fn of [...this.listeners]) fn();
  }

  search = async (query: string): Promise<PageRef[]> => {
    if (query.trim() !== "") return (await this.client.findPages(query, 8)).map(toRef);
    // Ohne Eingabe: zuletzt geöffnete Seiten.
    const ids = recentPages.get().map((r) => r.id).slice(0, 8);
    if (ids.length === 0) return [];
    const infos = await this.client.pageInfo(ids);
    return ids.map((id) => infos[id]).filter((p): p is PageInfo => !!p && !p.trashed).map(toRef);
  };

  /** „New page“ aus dem @-Menü: eine neue Seite oben in Private. */
  create = async (title: string): Promise<string | undefined> => {
    const id = await this.client.command<string | undefined>({ op: "createPage", title });
    return typeof id === "string" ? id : undefined;
  };

  /** BSD-207 „Move to“: letzter Sortierschlüssel der Zielseite – kurz deren Replik öffnen (geteilt, falls schon offen). */
  lastChildKey = async (pageID: string): Promise<string | undefined> => {
    const r = await this.client.openPage(pageID);
    try {
      const kids = r.store.children("b:" + pageID);
      const last = kids[kids.length - 1];
      return last === undefined ? undefined : r.store.blocks.get(last)?.sk;
    } finally {
      r.close();
    }
  };
}
