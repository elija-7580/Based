// BSD-153: was die Web-Shell im Browser behält (nicht im Workspace): Gerätekennung, Sync-Server, zuletzt geöffnete
// Seiten, aufgeklappte Seiten in der Seitenleiste. Alles über localStorage; scheitert das (privater Modus), gilt es
// nur für diese Sitzung.
import type { SyncConfig } from "../worker/protocol.js";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = storage()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === undefined) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // nur für diese Sitzung
  }
}

/** DeviceNodeStore-Gegenstück im Hauptthread (der Worker hat kein localStorage). */
export const deviceNode = {
  get: (): string | undefined => read<string | undefined>("based.device", undefined),
  set: (node: string) => write("based.device", node),
};

export const syncConfig = {
  get: (): SyncConfig | undefined => {
    const v = read<Partial<SyncConfig> | undefined>("based.sync", undefined);
    return v?.url ? { url: v.url, token: v.token ?? "" } : undefined;
  },
  set: (c: SyncConfig | undefined) => write("based.sync", c),
};

export interface RecentEntry {
  id: string;
  /** ms seit 1970. */
  at: number;
}

const RECENT_MAX = 20;
const recentListeners = new Set<(r: RecentEntry[]) => void>();

/** Zuletzt geöffnete Seiten, neueste zuerst. */
export const recentPages = {
  get: (): RecentEntry[] => read<RecentEntry[]>("based.recent", []).filter((e) => typeof e?.id === "string"),
  touch(id: string, now = Date.now()): RecentEntry[] {
    const next = [{ id, at: now }, ...recentPages.get().filter((e) => e.id !== id)].slice(0, RECENT_MAX);
    write("based.recent", next);
    for (const fn of recentListeners) fn(next);
    return next;
  },
  subscribe(fn: (r: RecentEntry[]) => void): () => void {
    recentListeners.add(fn);
    return () => recentListeners.delete(fn);
  },
};

export const expandedPages = {
  get: (): Set<string> => new Set(read<string[]>("based.expanded", [])),
  set: (s: ReadonlySet<string>) => write("based.expanded", [...s]),
};

export const collapsedSections = {
  get: (): Set<string> => new Set(read<string[]>("based.collapsed", [])),
  set: (s: ReadonlySet<string>) => write("based.collapsed", [...s]),
};
