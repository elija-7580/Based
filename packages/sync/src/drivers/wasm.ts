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

type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Pool = Awaited<ReturnType<Sqlite3["installOpfsSAHPoolVfs"]>>;

// Ein SQLite-Modul und ein Pool je Worker. Vorher holte jeder Aufruf ein eigenes Modul und damit einen zweiten Pool
// über dieselben OPFS-Dateien: die Zugriffe hielt schon der erste, history.sqlite und ydocs.sqlite fielen still auf
// den Speicher zurück (Versionsverlauf nach dem Neuladen weg) und die Konsole zeigte „based-sahpool:
// NoModificationAllowedError“ (Chromium) bzw. „InvalidStateError“ (WebKit) – gefunden beim Klick-Durchlauf BSD-300.
let module: Promise<Sqlite3> | undefined;
let pool: Promise<Pool> | undefined;

async function installPool(sqlite3: Sqlite3, waitMs: number): Promise<Pool> {
  const deadline = Date.now() + waitMs;
  for (let delay = 50; ; delay = Math.min(delay * 2, 400)) {
    try {
      // preserve…: bei einem Fehlschlag gibt der Pool seine schon geholten Dateien wieder frei (ohne sie zu löschen);
      // forceReinit…: ein gescheiterter Versuch bleibt sonst im Modul zwischengespeichert und jeder weitere scheitert.
      const options = { name: "based-sahpool", preserveOnInitFailure: true, forceReinitIfPreviouslyFailed: true };
      const p = await sqlite3.installOpfsSAHPoolVfs(options as Parameters<typeof sqlite3.installOpfsSAHPoolVfs>[0]);
      // Platz für based.sqlite, history.sqlite (BSD-73), ydocs.sqlite (BSD-220), ihre Journale und eine Sicherung.
      if (p.getCapacity() < 14) await p.reserveMinimumCapacity(14);
      return p;
    } catch (e) {
      // Warten hilft nur, wenn die Datei belegt ist (Chromium: NoModificationAllowedError, WebKit: InvalidStateError);
      // ohne OPFS oder in WebKits flüchtigen Profilen („unknown transient reason“) nicht
      if (Date.now() + delay > deadline || !busy(e)) throw e;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * SQLite-WASM schon holen und übersetzen, bevor die erste Datei geöffnet wird (store.worker.ts ruft das beim Laden
 * des Workers): das läuft dann neben dem Warten auf `init` statt danach. Öffnet nichts und fasst OPFS nicht an.
 */
export function preloadWasm(): void {
  if (module) return;
  const m = (module = sqlite3InitModule());
  // Scheitert das Laden, versucht es der erste `openWasmDatabase` neu (und meldet den Fehler dort).
  m.catch(() => { if (module === m) module = undefined; });
}

export async function openWasmDatabase(opts: WasmOptions = {}): Promise<SqlDatabase> {
  const sqlite3 = await (module ??= sqlite3InitModule());
  let db: Database;
  let shared: Pool | undefined;
  const file = opts.opfs ? "/" + opts.opfs.replace(/^\/+/, "") : undefined;
  if (file) {
    const p = (pool ??= installPool(sqlite3, opts.waitMs ?? 0));
    try {
      shared = await p;
    } catch (e) {
      if (pool === p) pool = undefined; // nächster Versuch (z. B. nach dem Schließen des anderen Tabs) darf neu
      throw e;
    }
    db = new shared.OpfsSAHPoolDb(file);
  } else {
    db = new sqlite3.oo1.DB(":memory:", "c");
  }
  // ADR 0017 A1: vorbereitete Anweisungen je Datenbank wiederverwenden (wie drivers/node.ts). Vorher bereitete jeder
  // Aufruf seine Anweisung neu vor – beim Schreiben in einem Zug (erster Sync, Import) der größte Posten.
  // Regeln: nach jedem Lauf zurücksetzen, nach einem Fehler verwerfen – sonst hält eine offene Anweisung die Transaktion;
  // vor dem Schließen alle freigeben, sonst gibt der Pool die OPFS-Datei nicht her. `exec` (mehrere Anweisungen,
  // PRAGMA, BEGIN/COMMIT) bleibt ohne Cache.
  type Statement = ReturnType<Database["prepare"]>;
  const statements = new Map<string, Statement>();
  const STATEMENT_LIMIT = 256;
  const prepare = (sql: string): Statement => {
    let st = statements.get(sql);
    if (st) return st;
    if (statements.size >= STATEMENT_LIMIT) {
      // Selten (SQL mit eingesetzten Namen): die älteste Anweisung freigeben.
      const [oldest, old] = statements.entries().next().value as [string, Statement];
      statements.delete(oldest);
      old.finalize();
    }
    st = db.prepare(sql);
    statements.set(sql, st);
    return st;
  };
  // Nach einem Fehler die Anweisung nicht behalten: `reset` meldet den Fehler des letzten Schritts noch einmal, und
  // eine halb gelaufene Anweisung darf nie die nächste Transaktion aufhalten. Der Fehler selbst geht an den Aufrufer.
  const discard = (sql: string, st: Statement) => {
    statements.delete(sql);
    try { st.finalize(); } catch { /* der ursprüngliche Fehler zählt */ }
  };
  const finalizeAll = () => {
    for (const st of statements.values()) {
      try { st.finalize(); } catch { /* schon freigegeben */ }
    }
    statements.clear();
  };
  return {
    exec: (sql) => void db.exec(sql),
    run: (sql, params = []) => {
      const st = prepare(sql);
      try {
        if (params.length) st.bind(params as BindableValue[]);
        st.step();
      } catch (e) {
        discard(sql, st);
        throw e;
      }
      st.reset(true);
    },
    all: (sql, params = []) => {
      const st = prepare(sql);
      const rows: SqlRow[] = [];
      try {
        if (params.length) st.bind(params as BindableValue[]);
        while (st.step()) rows.push(st.get({}) as SqlRow);
      } catch (e) {
        discard(sql, st);
        throw e;
      }
      st.reset(true);
      return rows;
    },
    each: (sql, params, row) => {
      const st = prepare(sql);
      try {
        if (params.length) st.bind(params as BindableValue[]);
        while (st.step()) row(st.get({}) as SqlRow);
      } catch (e) {
        discard(sql, st);
        throw e;
      }
      st.reset(true);
    },
    backup(version) {
      if (!shared || !file) return undefined;
      // Ohne WAL (die SAH-Pool-VFS kennt keinen) ist die Hauptdatei außerhalb einer Transaktion konsistent.
      const target = `${file}.bak-v${version}`;
      const bytes = shared.exportFile(file);
      for (const name of shared.getFileNames()) if (name.startsWith(file + ".bak-v")) shared.unlink(name);
      void shared.importDb(target, bytes);
      return target;
    },
    close: () => {
      finalizeAll();
      db.close();
    },
  };
}
