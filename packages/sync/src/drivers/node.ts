// Treiber für Node (Tests, CLI, Server-Werkzeuge) über das eingebaute node:sqlite (Node ≥ 22.5).
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from "node:sqlite";
import { readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type { SqlDatabase, SqlRow, SqlValue } from "../sql.js";

// Über require geladen: Vite/Vitest 2 kennen node:sqlite noch nicht als eingebautes Modul.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export function openNodeDatabase(path = ":memory:"): SqlDatabase {
  const db: DatabaseSyncType = new DatabaseSync(path);
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  const statements = new Map<string, ReturnType<DatabaseSyncType["prepare"]>>();
  const prepare = (sql: string) => {
    let st = statements.get(sql);
    if (!st) {
      st = db.prepare(sql);
      statements.set(sql, st);
    }
    return st;
  };
  return {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => void prepare(sql).run(...(params as SQLInputValue[])),
    all: (sql, params = []) => prepare(sql).all(...(params as SQLInputValue[])) as SqlRow[],
    backupIsComplete: true,
    backup(version) {
      if (path === ":memory:") return undefined;
      const target = `${path}.bak-v${version}`;
      rmSync(target, { force: true });
      db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      const prefix = basename(path) + ".bak-v";
      for (const name of readdirSync(dirname(path))) {
        if (name.startsWith(prefix) && name !== basename(target)) rmSync(join(dirname(path), name), { force: true });
      }
      return target;
    },
    close: () => db.close(),
  };
}

export type { SqlValue };
