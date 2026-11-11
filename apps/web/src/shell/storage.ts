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
/** BSD-235: im Gast-Tab nie den Klartext-Eintrag des Besitzers aus localStorage übernehmen (und dort löschen). */
let noMigrate = false;
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
      if (!noMigrate) await s.migrate(storage());
      syncCache = await s.getSync();
    } catch {
      // IndexedDB nicht nutzbar (manche privaten Fenster): alter Eintrag gilt für diese Sitzung
      const v = read<Partial<SyncConfig> | undefined>("based.sync", undefined);
      syncCache = v?.url ? { url: v.url, token: v.token ?? "" } : syncCache;
    }
    return syncCache;
  },
  /** Für Tests: anderen Speicher verwenden. */
  _use(store: SecretStore, opts: { noMigrate?: boolean } = {}) {
    secrets = store;
    syncCache = undefined;
    noMigrate = opts.noMigrate === true;
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

/**
 * Selbst gewähltes Home (Einstellungen → My settings, oder Rechtsklick auf eine Seite → „Set as Home“): eine Seiten-ID
 * oder `undefined` für das Dashboard. „Home“ in der Seitenleiste, neue Tabs und der App-Start führen dorthin.
 */
const startPageListeners = new Set<() => void>();
export const startPage = {
  get: (): string | undefined => {
    const v = read<unknown>("based.startPage", undefined);
    return typeof v === "string" && v ? v : undefined;
  },
  set: (id: string | undefined) => {
    write("based.startPage", id);
    startPageListeners.forEach((f) => f());
  },
  subscribe: (f: () => void) => {
    startPageListeners.add(f);
    return () => void startPageListeners.delete(f);
  },
};

/**
 * Wohin „Home“ führt: die gewählte Seite, solange es sie gibt (nicht gelöscht, nicht im Papierkorb), sonst das
 * Dashboard. `live` = IDs der vorhandenen Seiten; fehlt es (Workspace lädt noch), gilt die Wahl.
 */
export function homeTarget(chosen: string | undefined, live?: { has(id: string): boolean }): { name: "page"; id: string } | { name: "home" } {
  return chosen && (!live || live.has(chosen)) ? { name: "page", id: chosen } : { name: "home" };
}

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

/** Einfache Einstellung pro Gerät mit Benachrichtigung (für useSyncExternalStore). */
function devicePref<T>(key: string, fallback: T, valid: (v: unknown) => v is T) {
  const listeners = new Set<() => void>();
  let cache: { v: T } | undefined;
  return {
    get: (): T => {
      if (!cache) {
        const v = read<unknown>(key, undefined);
        cache = { v: valid(v) ? v : fallback };
      }
      return cache.v;
    },
    set: (v: T) => {
      cache = { v };
      write(key, v);
      listeners.forEach((fn) => fn());
    },
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

export interface NewPageFormat { font: "default" | "serif" | "mono"; smallText: boolean; fullWidth: boolean }
const isNewPageFormat = (v: unknown): v is NewPageFormat => {
  const o = v as Partial<NewPageFormat> | undefined;
  return !!o && typeof o === "object" && (o.font === "default" || o.font === "serif" || o.font === "mono") && typeof o.smallText === "boolean" && typeof o.fullWidth === "boolean";
};
/** BSD-168: Schrift, Small text und Full width für neue Seiten (Einstellungen → My settings → New pages). */
export const newPageFormat = devicePref<NewPageFormat>("based.newPageFormat", { font: "default", smallText: false, fullWidth: false }, isNewPageFormat);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
/** BSD-168: Rechtschreibprüfung beim Schreiben (Standard an, wie Swift). */
export const spellCheckPref = devicePref<boolean>("based.spellCheck", true, isBool);
/** BSD-168: Desktop-App sucht beim Start nach Updates (Standard an). */
export const autoUpdatePref = devicePref<boolean>("based.autoUpdateCheck", true, isBool);

/** BSD-281: angepinnte und ausgeblendete Einträge der Seitenleiste (pro Gerät). */
export const sidebarNavPrefs = {
  get: (): unknown => read<unknown>("based.sidebar.nav", undefined),
  set: (v: unknown) => write("based.sidebar.nav", v),
};

/** BSD-235: eigene Gerätekennung je Gast-Zugang (nie die des Besitzers: gleiche Kennung = gleiche Stempel). */
export const guestDeviceNode = (id: string) => ({
  get: (): string | undefined => read<string | undefined>(`based.guest.${id}.device`, undefined),
  set: (node: string) => write(`based.guest.${id}.device`, node),
});

/** BSD-319: Entwickler-Ansicht (Blockgrenzen, Ebenen, Fokus, letzte Ereignisse) – pro Gerät, Settings → Diagnostics. */
const devViewListeners = new Set<() => void>();
export const devViewPref = {
  get: (): boolean => read<unknown>("based.devView", false) === true,
  set: (on: boolean) => {
    write("based.devView", on ? true : undefined);
    devViewListeners.forEach((f) => f());
  },
  subscribe: (f: () => void) => {
    devViewListeners.add(f);
    return () => void devViewListeners.delete(f);
  },
};
