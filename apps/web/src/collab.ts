// BSD-220 Teil 3: Echtzeit-Text (Beta) – Seiten-Y.Docs über `<sync-url>/collab` (Hocuspocus, MIT) abgleichen. Die
// Regeln (Abstammung, Rückfall ohne /collab) liegen in @based/editor (CollabBinder); hier nur die Verbindung.
// Token aus dem verschlüsselten Speicher, als Hocuspocus-Auth-Nachricht – nie in der URL.
import { HocuspocusProvider } from "@hocuspocus/provider";
import { CollabBinder, type CollabConnection, type CollabSource, type YDocStore } from "@based/editor";
import type * as Y from "yjs";
import type { SyncConfig } from "./worker/protocol.js";

/** `https://host/pfad` → `wss://host/pfad/collab`. */
export function collabURL(syncURL: string): string {
  const u = new URL(syncURL);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = u.pathname.replace(/\/+$/, "") + "/collab";
  u.search = "";
  u.hash = "";
  return u.toString();
}

export function connectHocuspocus(cfg: SyncConfig, name: string, doc: Y.Doc): CollabConnection {
  let settle: { ok: () => void; fail: (e: Error) => void } | undefined;
  const synced = new Promise<void>((ok, fail) => (settle = { ok, fail }));
  synced.catch(() => undefined);
  const provider = new HocuspocusProvider({
    url: collabURL(cfg.url),
    name,
    document: doc,
    token: cfg.token,
    onSynced: () => settle?.ok(),
    onAuthenticationFailed: () => settle?.fail(new Error("collab: not authorised")),
  });
  return { synced, destroy: () => provider.destroy() };
}

/** Binder für die Shell: verbindet nur, wenn ein Server eingestellt und Echtzeit-Text an ist. */
export function createCollab(docStore: YDocStore, config: () => SyncConfig | undefined, unsynced?: (rootID: string) => Promise<boolean>): CollabBinder {
  return new CollabBinder({
    docStore,
    ...(unsynced ? { unsynced } : {}),
    syncTimeoutMs: 2500,
    // Offline nicht erst auf einen Abgleich warten (der Editor öffnete sonst verzögert); ein gespeicherter Stand vom
    // Server verbindet trotzdem – der Provider holt nach, sobald das Netz zurück ist.
    online: () => globalThis.navigator?.onLine !== false,
    connect: (name, doc) => {
      const cfg = config();
      if (!cfg?.url || !cfg.collab) return undefined;
      return connectHocuspocus(cfg, name, doc);
    },
  });
}

/** Nur die Wurzel der Seite selbst (der Server kennt nur Seiten; Synced-Block-Originale bleiben bei Records). */
export function pageCollab(binder: CollabSource, pageID: string): CollabSource {
  return { open: (rootID) => (rootID === pageID ? binder.open(rootID) : Promise.resolve(undefined)) };
}
