// BSD-583 (4): Felder, die die Beta nicht kennt (z. B. ein späteres `scope` oder `level` am Record für Ende-zu-Ende
// und „Open to agents“), überstehen Laden, Ändern und Sync unverändert – Ende-zu-Ende über den echten TS-Server, in
// beiden Datenformaten (BASED_PROPERTY_RECORDS=0/1). Siehe auch packages/sync/test/future-format.test.ts (1–3).
import { afterEach, describe, expect, it } from "vitest";
import {
  addProperty, addRow, addView, createDatabase, createPage, renamePage, renameProperty, renameView, setValue, WorkspaceStore,
  type RecordKind, type WireRecord,
} from "@based/core";
import { openWorkspace, SyncClient, type SqlDatabase } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { startApp, TOKEN } from "./helpers.js";

const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

/** Was ein späterer Build an Records hängen könnte (oben und verschachtelt). */
const FUTURE = { scope: "private", level: 2, sealed: { v: 1, keyID: "k1" } };

const pick = (data: Record<string, unknown>) => ({ scope: data.scope, level: data.level, sealed: data.sealed });
/** Schlüssel-ID eines Records (Property-Records: `<databaseID>/<propertyID>`). */
const idOf = (r: WireRecord) => (r.kind === "property" ? `${(r.data as { databaseID: string }).databaseID}/${(r.data as { schema: { id: string } }).schema.id}` : (r.data as { id: string }).id);
const recordOf = (store: WorkspaceStore, kind: RecordKind, id: string) =>
  store.allRecords().find((r) => r.kind === kind && idOf(r) === id)?.data as Record<string, unknown> | undefined;
/** Rohe Zeile aus based.sqlite (was nach einem Neustart geladen wird). */
const rowOf = (db: SqlDatabase, kind: RecordKind, id: string) => {
  const r = db.all("SELECT data FROM records WHERE kind = ? AND id = ?", [kind, id])[0];
  return r ? (JSON.parse(new TextDecoder().decode(r.data as Uint8Array)) as Record<string, unknown>) : undefined;
};

describe("BSD-583 (4): unbekannte Felder überstehen Laden, Ändern und Sync", () => {
  it("Seite, Block, Datenbank, Zeile und Ansicht: Gerät A → Server → Gerät B → zurück, nach Neustart unverändert", async () => {
    const app = await startApp();
    apps.push(app);
    const fileA = openNodeDatabase();
    let a = openWorkspace(fileA, { node: "deviceA" });
    const client = (d: ReturnType<typeof openWorkspace>) => new SyncClient(d.store, d.persistence, { baseURL: app.url, token: TOKEN });

    // Ausgangslage aus der Beta
    const page = createPage(a.store, { title: "Plan" });
    a.store.transact("t", (tx) => tx.put({ kind: "block", data: { id: "fut-text", type: "text", parent: "b:" + page, sk: "a0", text: "secret", createdAt: 0, updatedAt: 0 } } as WireRecord));
    const db = createDatabase(a.store, { parent: "b:" + page, title: "Tasks", inline: true, sampleRows: 0 });
    const note = addProperty(a.store, db.databaseID, "Note", "text")!;
    const row = addRow(a.store, db.databaseID, { title: "Row" })!;
    const view = addView(a.store, db.blockID, "board", "Board")!;
    await client(a).syncOnce();

    // ein späterer Build (anderes Gerät) hängt neue Felder an und synct: so kommen sie bei der Beta an
    const later = openWorkspace(openNodeDatabase(), { node: "laterBuild" });
    await client(later).syncOnce();
    const targets: [RecordKind, string][] = [["block", page], ["block", "fut-text"], ["block", row], ["database", db.databaseID], ["view", view]];
    // neues Datenformat: Spalten sind eigene Records und bekommen die Felder auch
    if (a.store.propertyRecords) targets.push(["property", `${db.databaseID}/${note}`]);
    later.store.transact("future", (tx) => {
      for (const [kind, id] of targets) tx.put({ kind, data: { ...structuredClone(recordOf(later.store, kind, id)!), ...FUTURE } } as unknown as WireRecord);
    });
    await client(later).syncOnce();

    // Beta (A) bekommt sie, ändert jeden dieser Records mit den normalen Befehlen und synct zurück
    await client(a).syncOnce();
    for (const [kind, id] of targets) expect(pick(recordOf(a.store, kind, id)!), `${kind}:${id} nach Pull`).toEqual(FUTURE);
    renamePage(a.store, page, "Plan (edited in beta)");
    a.store.transact("t", (tx) => tx.put({ kind: "block", data: { ...structuredClone(recordOf(a.store, "block", "fut-text")!), text: "edited" } } as WireRecord));
    setValue(a.store, row, note, { text: { _0: "from beta" } });
    renamePage(a.store, db.blockID, "Tasks (edited)");
    renameView(a.store, view, "Board (edited)");
    renameProperty(a.store, db.databaseID, note, "Notes");
    for (const [kind, id] of targets) expect(pick(recordOf(a.store, kind, id)!), `${kind}:${id} nach Ändern`).toEqual(FUTURE);
    await client(a).syncOnce();

    // nach einem Neustart der Beta: aus der Datei geladen, Felder noch da
    a = openWorkspace(fileA, { node: "deviceA" });
    for (const [kind, id] of targets) {
      expect(pick(rowOf(fileA, kind, id)!), `${kind}:${id} in based.sqlite`).toEqual(FUTURE);
      expect(pick(recordOf(a.store, kind, id)!), `${kind}:${id} nach Neustart`).toEqual(FUTURE);
    }

    // Server und der spätere Build sehen die Änderungen der Beta – mit den Feldern
    const onServer = app.sync.pull(0).records;
    for (const [kind, id] of targets) {
      const s = onServer.find((r) => r.kind === kind && idOf(r) === id)!;
      expect(pick(s.data as Record<string, unknown>), `${kind}:${id} auf dem Server`).toEqual(FUTURE);
    }
    await client(later).syncOnce();
    expect(later.store.blocks.get(page)?.text).toBe("Plan (edited in beta)");
    expect(later.store.blocks.get("fut-text")?.text).toBe("edited");
    expect(later.store.databases.get(db.databaseID)?.title).toBe("Tasks (edited)");
    expect(later.store.views.get(view)?.name).toBe("Board (edited)");
    expect(later.store.databases.get(db.databaseID)?.properties.find((p) => p.id === note)?.name).toBe("Notes");
    for (const [kind, id] of targets) expect(pick(recordOf(later.store, kind, id)!), `${kind}:${id} beim späteren Build`).toEqual(FUTURE);
  });
});
