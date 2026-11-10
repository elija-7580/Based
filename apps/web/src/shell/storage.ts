// BSD-153: was die Web-Shell im Browser behält (nicht im Workspace): Gerätekennung, Sync-Server, zuletzt geöffnete
// Seiten, aufgeklappte Seiten in der Seitenleiste. Alles über localStorage; scheitert das (privater Modus), gilt es
// nur für diese Sitzung. Ausnahme: Sync-Server und Token liegen verschlüsselt in IndexedDB (secrets.ts).
import type { SyncConfig } from "../worker/protocol.js";
import { indexedDBKV, memoryKV, SecretStore } from "./secrets.js";

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

let secrets: SecretStore | undefined;
const secretStore = () => (secrets ??= new SecretStore(typeof indexedDB === "undefined" ? memoryKV() : indexedDBKV()));
/** Die verschlüsselte Ablage (IndexedDB; ohne IndexedDB nur für diese Sitzung im Speicher – nie Klartext im localStorage). */
export const secretVault = (): SecretStore => secretStore();
let syncCache: SyncConfig | undefined;
let syncWrite: Promise<void> = Promise.resolve();

/**
 * Sync-Server und Token. Gespeichert verschlüsselt in IndexedDB (asynchron); `get`/`set` arbeiten auf einer Kopie im
 * Speicher, die `load()` beim Start füllt (und dabei den alten Klartext-Eintrag aus localStorage übernimmt).
 */
export const syncConfig = {
  get: (): SyncConfig | undefined => syncCache,
  set: (c: SyncConfig | undefined) => {
    const value: SyncConfig | undefined = c?.url ? { url: c.url, token: c.token, ...(c.collab ? { collab: true } : {}) } : undefined;
    syncCache = value;
    syncWrite = syncWrite.then(() => secretStore().setSync(value)).catch(() => undefined);
  },
  /** Wartet, bis die letzte Änderung verschlüsselt in IndexedDB liegt (vor dem Verbinden: sonst kann ein schnelles
   *  Neuladen sie verlieren). */
  flush: (): Promise<void> => syncWrite,
  /** Aus IndexedDB lesen (beim Start und wenn dieser Tab den Store übernimmt – ein anderer Tab kann ihn geändert haben). */
  async load(): Promise<SyncConfig | undefined> {
    try {
      await syncWrite;
      const s = secretStore();
      await s.migrate(storage());
      syncCache = await s.getSync();
    } catch {
      // IndexedDB nicht nutzbar (manche privaten Fenster): alter Eintrag gilt für diese Sitzung
      const v = read<Partial<SyncConfig> | undefined>("based.sync", undefined);
      syncCache = v?.url ? { url: v.url, token: v.token ?? "" } : syncCache;
    }
    return syncCache;
  },
  /** Für Tests: anderen Speicher verwenden. */
  _use(store: SecretStore) {
    secrets = store;
    syncCache = undefined;
  },
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

/** Selbst gewählte Startseite (Einstellungen → My settings): eine Seiten-ID oder `undefined` für Home. */
export const startPage = {
  get: (): string | undefined => {
    const v = read<unknown>("based.startPage", undefined);
    return typeof v === "string" && v ? v : undefined;
  },
  set: (id: string | undefined) => write("based.startPage", id),
};

export const expandedPages = {
  get: (): Set<string> => new Set(read<string[]>("based.expanded", [])),
  set: (s: ReadonlySet<string>) => write("based.expanded", [...s]),
};

export const collapsedSections = {
  get: (): Set<string> => new Set(read<string[]>("based.collapsed", [])),
  set: (s: ReadonlySet<string>) => write("based.collapsed", [...s]),
};

// BSD-205: Wochenbeginn (Einstellungen → Language & region), pro Gerät; `undefined` = aus der Sprache des Systems.
const weekStartListeners = new Set<() => void>();
export const weekStartPref = {
  get: (): number | undefined => {
    const v = read<unknown>("based.weekStart", undefined);
    return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6 ? v : undefined;
  },
  set: (day: number | undefined) => {
    write("based.weekStart", day);
    weekStartListeners.forEach((fn) => fn());
  },
  subscribe: (fn: () => void) => {
    weekStartListeners.add(fn);
    return () => weekStartListeners.delete(fn);
  },
};
