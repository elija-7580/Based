// Treiber für den Browser: SQLite-WASM, dauerhaft im Origin Private File System über die „opfs-sahpool“-VFS
// (braucht keine COOP/COEP-Header, aber einen Dedicated Worker – der Store läuft deshalb im Worker).
// Ohne `opfs` (oder in Node) eine In-Memory-Datenbank, z. B. für Tests.
import sqlite3InitModule, { type BindableValue, type Database } from "@sqlite.org/sqlite-wasm";
import type { SqlDatabase, SqlRow } from "../sql.js";

export interface WasmOptions {
  /** Dateiname im OPFS-Pool, z. B. "based.sqlite". Ohne Angabe: In-Memory. */
  opfs?: string;
}

export async function openWasmDatabase(opts: WasmOptions = {}): Promise<SqlDatabase> {
  const sqlite3 = await sqlite3InitModule();
  let db: Database;
  let pool: Awaited<ReturnType<typeof sqlite3.installOpfsSAHPoolVfs>> | undefined;
  const file = opts.opfs ? "/" + opts.opfs.replace(/^\/+/, "") : undefined;
  if (file) {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: "based-sahpool" });
    db = new pool.OpfsSAHPoolDb(file);
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
