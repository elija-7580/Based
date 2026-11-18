// BSD-215 / BSD-435: 100 000 Datenbankzeilen in SQLite speichern und beim nächsten Start laden. Grenzwerte großzügig (CI).
// BSD-559: gemessen als CPU-Zeit mit `expectWithinBudget` (bester von drei Durchgängen, in der CI nur Warnung) –
// die Wanduhr lag unter `run-ts.sh` neben einem WebKit-Lauf bei 17 s und brach den ganzen Prüflauf ab.
import { describe, expect, it } from "vitest";
import { createDatabase, keysBetween } from "@based/core";
import { openWorkspace } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import { cpuTime, expectWithinBudget } from "../../core/test/perf-budget.js";

describe("Große Datenbank aus SQLite (BSD-215)", () => {
  it("100 000 Zeilen speichern und neu laden", () => {
    const N = 100_000;
    const keys = keysBetween(N, undefined, undefined);
    const run = () => {
      const db = openNodeDatabase();
      const first = openWorkspace(db, { node: "AAAA" });
      const made = createDatabase(first.store, { parent: "w", title: "Big", sampleRows: 0 });
      const save = cpuTime(() => first.store.transact("Seed", (tx) => {
        for (let i = 0; i < N; i++) tx.put({ kind: "block", data: { id: "r" + i, type: "page", parent: "d:" + made.databaseID, sk: keys[i]!, text: "Row " + i, createdAt: 0, updatedAt: 0 } });
      }, { undoable: false }));
      let second: ReturnType<typeof openWorkspace> | undefined;
      const load = cpuTime(() => { second = openWorkspace(db, { node: "AAAA" }); });
      expect(second!.store.children("d:" + made.databaseID).length).toBe(N);
      console.info(`BSD-215 SQLite: ${N} Zeilen speichern ${save.toFixed(0)} ms, laden ${load.toFixed(0)} ms (CPU)`);
      return { save, load };
    };
    expectWithinBudget("BSD-215 100 000 Zeilen SQLite", { save: 15_000, load: 10_000 }, run);
  }, 180_000);
});
