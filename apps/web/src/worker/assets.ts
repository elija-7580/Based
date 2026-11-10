// Asset-Speicher der Web-Shell: Bilder und Anhänge (Import, später Uploads) als Bytes in IndexedDB, Schlüssel = Asset-ID
// aus den Records (`props.asset.id`). IndexedDB, weil alle drei Stellen daran müssen – der Import-Worker schreibt, der
// Hauptthread liest für die Anzeige (`based-asset:<id>` → Blob-URL), der Store-Worker liest für Exporte – und OPFS im
// Hauptthread nicht überall schreibbar ist. Nur lokal: Dateien werden (noch) nicht mit dem Server abgeglichen.
import type { AssetRef } from "@based/core";

export interface StoredAsset {
  data: Uint8Array;
  name: string;
  mime?: string;
}

/**
 * Die ganze Schnittstelle zum Dateispeicher (absichtlich klein, damit eine andere Ablage – z. B. ein OPFS-Blob-Speicher
 * im Worker – sie ersetzen kann). Schlüssel ist die Asset-ID aus den Records (`props.asset.id`, wie Swift `AssetRef.id`).
 */
export interface AssetStore {
  put(id: string, asset: StoredAsset): Promise<void>;
  get(id: string): Promise<StoredAsset | undefined>;
  has(id: string): Promise<boolean>;
}

export class MemoryAssetStore implements AssetStore {
  readonly files = new Map<string, StoredAsset>();
  async put(id: string, asset: StoredAsset): Promise<void> {
    this.files.set(id, asset);
  }
  async get(id: string): Promise<StoredAsset | undefined> {
    return this.files.get(id);
  }
  async has(id: string): Promise<boolean> {
    return this.files.has(id);
  }
}

const DB_NAME = "based-assets";
const STORE = "files";

function open(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
    req.onblocked = () => reject(new Error("IndexedDB blocked"));
  });
}

const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });

/** Speicher in IndexedDB. Die Verbindung entsteht beim ersten Zugriff; Fehler (privates Fenster, Kontingent) kommen als Ablehnung. */
export class IDBAssetStore implements AssetStore {
  private db: Promise<IDBDatabase> | undefined;
  constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {}

  private conn(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new Error("IndexedDB unavailable"));
    this.db ??= open(this.factory).catch((e: unknown) => {
      this.db = undefined;
      throw e;
    });
    return this.db;
  }

  /** Lässt sich der Speicher öffnen? (Import fragt vorher, damit Blöcke nicht auf Dateien zeigen, die es nicht gibt.) */
  async available(): Promise<boolean> {
    try {
      await this.conn();
      return true;
    } catch {
      return false;
    }
  }

  async put(id: string, asset: StoredAsset): Promise<void> {
    const db = await this.conn();
    const tx = db.transaction(STORE, "readwrite");
    // Eigene Kopie des Puffers: `data` kann ein Ausschnitt eines großen ZIP-Puffers sein.
    const bytes = asset.data.slice();
    const value: { data: ArrayBuffer; name: string; mime?: string } = { data: bytes.buffer, name: asset.name };
    if (asset.mime) value.mime = asset.mime;
    await done(tx.objectStore(STORE).put(value, id));
  }

  async get(id: string): Promise<StoredAsset | undefined> {
    const db = await this.conn();
    const v = (await done(db.transaction(STORE, "readonly").objectStore(STORE).get(id))) as { data: ArrayBuffer; name: string; mime?: string } | undefined;
    if (!v) return undefined;
    const out: StoredAsset = { data: new Uint8Array(v.data), name: v.name };
    if (v.mime) out.mime = v.mime;
    return out;
  }

  async has(id: string): Promise<boolean> {
    const db = await this.conn();
    return (await done(db.transaction(STORE, "readonly").objectStore(STORE).count(id))) > 0;
  }
}

/** Liest die Dateien zu `refs` vorab (Exporte brauchen sie synchron). Fehlende fehlen in der Karte. */
export async function loadAssets(store: AssetStore | undefined, refs: readonly AssetRef[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  if (!store) return out;
  await Promise.all(refs.map(async (ref) => {
    try {
      const a = await store.get(ref.id);
      if (a) out.set(ref.id, a.data);
    } catch {
      // nicht lesbar: der Export meldet die Datei als fehlend
    }
  }));
  return out;
}

export const ASSET_URL_PREFIX = "based-asset:";

/**
 * Löst `based-asset:<id>` in eine Blob-URL auf (für Editor und Lese-Ansicht); andere URLs bleiben. Blob-URLs werden
 * je ID einmal erzeugt und für die Sitzung behalten.
 */
export function assetURLResolver(store: AssetStore, createURL: (blob: Blob) => string = (b) => URL.createObjectURL(b)): (url: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (url) => {
    if (!url.startsWith(ASSET_URL_PREFIX)) return Promise.resolve(url);
    const id = url.slice(ASSET_URL_PREFIX.length);
    let p = cache.get(id);
    if (!p) {
      p = store.get(id).then((a) => {
        if (!a) throw new Error("This file isn't on this device.");
        return createURL(new Blob([a.data as BlobPart], a.mime ? { type: a.mime } : {}));
      });
      p.catch(() => cache.delete(id));
      cache.set(id, p);
    }
    return p;
  };
}
