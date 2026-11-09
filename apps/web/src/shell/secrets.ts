// Sync-Server und Token: nicht mehr im Klartext im localStorage, sondern verschlüsselt in IndexedDB.
//
// Wie: Beim ersten Speichern erzeugt der Browser einen AES-GCM-Schlüssel mit `extractable: false` und legt das
// CryptoKey-Objekt selbst in IndexedDB ab (strukturiert klonbar). Die Rohbytes des Schlüssels verlassen die Krypto-
// Implementierung des Browsers nie – auch nicht für Skripte dieser Seite (`exportKey` scheitert). Gespeichert wird
// `{ url, iv, data }` mit dem Token als Geheimtext.
//
// Wovor das schützt – und wovor nicht (ehrlich):
//  + Das Token steht nirgends im Klartext auf der Platte oder in Profil-/Backup-Kopien (localStorage ist eine
//    einfache Datei im Browserprofil). Wer nur die Dateien hat (Backup, kopiertes Profil, Debug-Dump), sieht weder
//    Token noch Schlüssel als Text; der Schlüssel liegt zwar im selben Profil, aber in der internen Form des Browsers,
//    die ohne diesen Browser nicht ohne Weiteres zu entschlüsseln ist (eine Hürde, kein Tresor).
//  + Schnelle Blicke in die Entwicklerwerkzeuge (Application → Local Storage) und Erweiterungen, die nur
//    localStorage auslesen, zeigen kein Token mehr.
//  − NICHT geschützt gegen Skripte im selben Origin (XSS, bösartige Abhängigkeit): Die dürfen den Schlüssel benutzen
//    und das Token genauso entschlüsseln wie diese App. Der Store-Tab hält das Token außerdem im Speicher, solange
//    Sync läuft.
//  − NICHT geschützt gegen jemanden mit Zugriff auf das entsperrte Gerät und den Browser.
// Wirklich sicher wäre nur ein Token, das die Seite gar nicht sieht (HttpOnly-Cookie vom Server) – das braucht den
// Sync-Server und ist eigene Arbeit.
import type { SyncConfig } from "../worker/protocol.js";

/** Minimaler Schlüssel-Wert-Speicher (IndexedDB im Browser, Map in Tests). */
export interface SecretKV {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Sealed {
  v: 1;
  url: string;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

const KEY = "key";
const SYNC = "sync";
/** Alter Klartext-Eintrag (bis zu dieser Fassung). */
export const LEGACY_SYNC_KEY = "based.sync";

export class SecretStore {
  constructor(
    private readonly kv: SecretKV,
    private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
  ) {}

  private async key(create: boolean): Promise<CryptoKey | undefined> {
    const existing = await this.kv.get(KEY);
    if (existing && typeof existing === "object") return existing as CryptoKey;
    if (!create) return undefined;
    const key = await this.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await this.kv.set(KEY, key);
    return key;
  }

  async getSync(): Promise<SyncConfig | undefined> {
    const sealed = (await this.kv.get(SYNC)) as Sealed | undefined;
    if (!sealed?.url) return undefined;
    const key = await this.key(false);
    if (!key) return { url: sealed.url, token: "" };
    try {
      const plain = await this.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, key, sealed.data);
      return { url: sealed.url, token: new TextDecoder().decode(plain) };
    } catch {
      // Schlüssel weg/anders (Profil teilweise zurückgesetzt): Server behalten, Token neu eingeben lassen
      return { url: sealed.url, token: "" };
    }
  }

  async setSync(c: SyncConfig | undefined): Promise<void> {
    if (!c?.url) {
      await this.kv.delete(SYNC);
      return;
    }
    const key = (await this.key(true))!;
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const data = await this.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(c.token));
    const sealed: Sealed = { v: 1, url: c.url, iv, data };
    await this.kv.set(SYNC, sealed);
  }

  /**
   * Alten Klartext-Eintrag aus localStorage übernehmen und dort löschen. Ein schon vorhandener verschlüsselter Eintrag
   * gewinnt (der alte stammt dann aus einer älteren Fassung in einem anderen Tab).
   */
  async migrate(storage: Pick<Storage, "getItem" | "removeItem"> | undefined): Promise<void> {
    const raw = storage?.getItem(LEGACY_SYNC_KEY);
    if (raw == null) return;
    let legacy: Partial<SyncConfig> | undefined;
    try {
      legacy = JSON.parse(raw) as Partial<SyncConfig>;
    } catch {
      legacy = undefined;
    }
    if (legacy?.url && !(await this.kv.get(SYNC))) await this.setSync({ url: legacy.url, token: legacy.token ?? "" });
    storage?.removeItem(LEGACY_SYNC_KEY);
  }
}

/** Speicher in einer Map (Tests, oder wenn IndexedDB fehlt: dann nur für diese Sitzung). */
export function memoryKV(): SecretKV & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    delete: async (k) => void map.delete(k),
  };
}

/** IndexedDB „based-secrets“, ein Objektspeicher „kv“. */
export function indexedDBKV(name = "based-secrets"): SecretKV {
  let opened: Promise<IDBDatabase> | undefined;
  const db = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB"));
    }));
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction("kv", mode);
      const req = fn(tx.objectStore("kv"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB"));
    });
  };
  return {
    get: (k) => run("readonly", (s) => s.get(k)),
    set: async (k, v) => void (await run("readwrite", (s) => s.put(v, k))),
    delete: async (k) => void (await run("readwrite", (s) => s.delete(k))),
  };
}
