// BSD-215: 50 000 Datenbankzeilen in SQLite speichern und beim nächsten Start laden. Grenzwerte großzügig (CI).
import { describe, expect, it } from "vitest";
import { createDatabase, keysBetween } from "@based/core";
import { openWorkspace } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";

describe("Große Datenbank aus SQLite (BSD-215)", () => {
  it("50 000 Zeilen speichern und neu laden", () => {
    const N = 50_000;
    const db = openNodeDatabase();
    const first = openWorkspace(db, { node: "AAAA" });
    const made = createDatabase(first.store, { parent: "w", title: "Big", sampleRows: 0 });
    const keys = keysBetween(N, undefined, undefined);
    const t0 = performance.now();
    first.store.transact("Seed", (tx) => {
      for (let i = 0; i < N; i++) tx.put({ kind: "block", data: { id: "r" + i, type: "page", parent: "d:" + made.databaseID, sk: keys[i]!, text: "Row " + i, createdAt: 0, updatedAt: 0 } });
    }, { undoable: false });
    const save = performance.now() - t0;

    const t1 = performance.now();
    const second = openWorkspace(db, { node: "AAAA" });
    const load = performance.now() - t1;
    expect(second.store.children("d:" + made.databaseID).length).toBe(N);
    console.info(`BSD-215 SQLite: ${N} Zeilen speichern ${save.toFixed(0)} ms, laden ${load.toFixed(0)} ms`);
    expect(save).toBeLessThan(15_000);
    expect(load).toBeLessThan(10_000);
  }, 60_000);
});
