// BSD-220 Teil 2: Y-Zustände der Editor-Dokumente dauerhaft ablegen. Eigene Datei `ydocs.sqlite` neben dem Workspace
// (nie gesynct), aus demselben Grund wie history.sqlite: eine neue Tabelle in based.sqlite bräuchte Migration v4, und
// die Swift-App (kennt bis v3) hielte die Datei dann für „newerFormat“. Der Y-Zustand ist ein Cache für Editor und
// /collab: die Records bleiben die Quelle; fehlt oder bricht ein Zustand, baut die DocSession ihn aus den Records neu.
import { asText, first, type SqlDatabase, type SqlValue } from "./sql.js";

export const YDOCS_SCHEMA = `
CREATE TABLE IF NOT EXISTS ydocs (root TEXT PRIMARY KEY, state BLOB NOT NULL, updated REAL NOT NULL) WITHOUT ROWID;
`;

/** Ablage der Y-Zustände je Dokument-Wurzel (Seite oder Synced-Block-Original). */
export interface YDocStorage {
  get(rootID: string): Uint8Array | undefined;
  put(rootID: string, state: Uint8Array): void;
  delete(rootID: string): void;
  roots(): string[];
}

const blob = (v: SqlValue | undefined): Uint8Array | undefined => (v instanceof Uint8Array ? v : undefined);

export class SqliteYDocStorage implements YDocStorage {
  constructor(readonly db: SqlDatabase, private readonly now: () => number = () => Date.now() / 1000) {
    db.exec(YDOCS_SCHEMA);
  }

  get(rootID: string) {
    return blob(first(this.db, "SELECT state FROM ydocs WHERE root = ?", [rootID])?.state);
  }

  put(rootID: string, state: Uint8Array) {
    this.db.run("INSERT INTO ydocs(root, state, updated) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET state = excluded.state, updated = excluded.updated",
      [rootID, state, this.now()]);
  }

  delete(rootID: string) {
    this.db.run("DELETE FROM ydocs WHERE root = ?", [rootID]);
  }

  roots() {
    return this.db.all("SELECT root FROM ydocs ORDER BY root").map((r) => asText(r.root) ?? "");
  }
}

export class MemoryYDocStorage implements YDocStorage {
  private readonly states = new Map<string, Uint8Array>();
  get(rootID: string) {
    return this.states.get(rootID);
  }
  put(rootID: string, state: Uint8Array) {
    this.states.set(rootID, state.slice());
  }
  delete(rootID: string) {
    this.states.delete(rootID);
  }
  roots() {
    return [...this.states.keys()].sort();
  }
}
