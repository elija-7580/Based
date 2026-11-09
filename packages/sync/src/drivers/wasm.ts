// Treiber für den Browser: SQLite-WASM, dauerhaft im Origin Private File System über die „opfs-sahpool“-VFS
// (braucht keine COOP/COEP-Header, aber einen Dedicated Worker – der Store läuft deshalb im Worker).
// Ohne `opfs` (oder in Node) eine In-Memory-Datenbank, z. B. für Tests.
import sqlite3InitModule, { type BindableValue, type Database } from "@sqlite.org/sqlite-wasm";
import type { SqlDatabase, SqlRow } from "../sql.js";

export interface WasmOptions {
  /** Dateiname im OPFS-Pool, z. B. "based.sqlite". Ohne Angabe: In-Memory. */
  opfs?: string;
  /**
   * So lange (ms) erneut versuchen, wenn die Pool-Dateien noch von einem anderen Kontext gehalten werden – z. B. vom
   * Worker eines gerade geschlossenen Tabs, dessen Zugriffe der Browser erst kurz nach dem Web Lock freigibt.
   * Standard 0 (ein Versuch, wie bisher).
   */
  waitMs?: number;
}

function busy(e: unknown): boolean {
  const parts: string[] = [];
  for (let x: unknown = e, i = 0; x && i < 4; x = (x as { cause?: unknown }).cause, i++) {
    parts.push(String((x as { name?: unknown }).name ?? ""), String((x as { message?: unknown }).message ?? x));
  }
  return /NoModificationAllowed|InvalidState|invalid state|Access Handle/i.test(parts.join(" "));
}

export async function openWasmDatabase(opts: WasmOptions = {}): Promise<SqlDatabase> {
  const sqlite3 = await sqlite3InitModule();
  let db: Database;
  let pool: Awaited<ReturnType<typeof sqlite3.installOpfsSAHPoolVfs>> | undefined;
  const file = opts.opfs ? "/" + opts.opfs.replace(/^\/+/, "") : undefined;
  if (file) {
    const deadline = Date.now() + (opts.waitMs ?? 0);
    for (let delay = 50; ; delay = Math.min(delay * 2, 400)) {
      try {
        // preserve…: bei einem Fehlschlag gibt der Pool seine schon geholten Dateien wieder frei (ohne sie zu löschen);
        // forceReinit…: ein gescheiterter Versuch bleibt sonst im Modul zwischengespeichert und jeder weitere scheitert.
        const options = { name: "based-sahpool", preserveOnInitFailure: true, forceReinitIfPreviouslyFailed: true };
        pool = await sqlite3.installOpfsSAHPoolVfs(options as Parameters<typeof sqlite3.installOpfsSAHPoolVfs>[0]);
        break;
      } catch (e) {
        // Warten hilft nur, wenn die Datei belegt ist (Chromium: NoModificationAllowedError, WebKit: InvalidStateError);
        // ohne OPFS oder in WebKits flüchtigen Profilen („unknown transient reason“) nicht
        if (Date.now() + delay > deadline || !busy(e)) throw e;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    db = new pool!.OpfsSAHPoolDb(file);
  } else {
    db = new sqlite3.oo1.DB(":memory:", "c");
  }
  const bind = (params: unknown[]) => (params.length ? (params as BindableValue[]) : undefined);
  return {
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => {
      const b = bind(params);
      db.exec(b ? { sql, bind: b } : { sql });
    },
    all: (sql, params = []) => {
      const b = bind(params);
      return (b ? db.selectObjects(sql, b) : db.selectObjects(sql)) as SqlRow[];
    },
    backup(version) {
      if (!pool || !file) return undefined;
      // Ohne WAL (die SAH-Pool-VFS kennt keinen) ist die Hauptdatei außerhalb einer Transaktion konsistent.
      const target = `${file}.bak-v${version}`;
      const bytes = pool.exportFile(file);
      for (const name of pool.getFileNames()) if (name.startsWith(file + ".bak-v")) pool.unlink(name);
      void pool.importDb(target, bytes);
      return target;
    },
    close: () => db.close(),
  };
}
