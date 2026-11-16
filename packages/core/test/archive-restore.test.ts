// BSD-423: Archiv-Import als Rückweg. Mac-Test 14.11.: Workspace als Based-Archiv exportiert, alles gelöscht und den
// Papierkorb geleert, Archiv importiert – Based zeigte nichts an. Ursache: Last-Writer-Wins gegen die Löschung (die
// Papierkorb-Markierung und die Tombstones sind neuer als die Archivversion), und der Bericht zählte das als importiert.
import { describe, expect, it } from "vitest";
import {
  compareStamps, createDatabase, createPage, emptyTrash, importArchiveRecords, loadArchive, MemoryPersistence, recordKey, topLevelPages,
  trashPages, WorkspaceStore, writeArchivePackage, type Stamp,
} from "../src/index.js";

const store = (node = "t") => new WorkspaceStore({ persistence: new MemoryPersistence(), node, propertyRecords: true });

function sample() {
  const s = store();
  const a = createPage(s, { title: "Alpha" });
  createPage(s, { title: "Alpha child", parent: a });
  createPage(s, { title: "Beta" });
  const db = createDatabase(s, { parent: "w", title: "Tasks", sampleRows: 3 });
  return { s, a, db };
}

const titles = (s: WorkspaceStore) => topLevelPages(s).map((b) => (typeof b.text === "string" ? b.text : JSON.stringify(b.text))).sort();
const roundTrip = (s: WorkspaceStore) => loadArchive(writeArchivePackage(s, () => undefined).zip).read;

describe("BSD-423 Archiv-Import nach „alles löschen“", () => {
  it("Papierkorb geleert: alle Seiten, Unterseiten, Datenbank, Zeilen und Ansichten kommen zurück", () => {
    const { s, a, db } = sample();
    const before = titles(s);
    const blocks = s.blocks.size, views = s.views.size, dbs = s.databases.size;
    const archive = roundTrip(s);
    trashPages(s, topLevelPages(s).map((b) => b.id));
    emptyTrash(s);
    expect(topLevelPages(s)).toHaveLength(0);
    expect(s.databases.size).toBe(0);

    const r = importArchiveRecords(s, archive);
    expect(titles(s)).toEqual(before);
    expect(s.blocks.size).toBe(blocks);
    expect(s.views.size).toBe(views);
    expect(s.databases.size).toBe(dbs);
    expect(s.databases.get(db.databaseID)?.properties.length).toBeGreaterThan(0);
    expect(s.children("b:" + a)).toHaveLength(1);
    expect(r.restored).toBeGreaterThan(0);
    expect(r.imported).toBeGreaterThanOrEqual(r.restored!);
    // Neu gestempelt: schlägt die Löschung auch auf anderen Geräten (Sync), Tombstones sind kein Hindernis mehr.
    for (const b of s.blocks.values()) {
      const ts = s.persistence?.tombstone(recordKey({ kind: "block", data: b }));
      if (ts) expect(compareStamps(b.stamp as Stamp, ts)).toBeGreaterThan(0);
    }
  });

  it("Nur im Papierkorb: die Seiten kommen aus dem Papierkorb zurück", () => {
    const { s } = sample();
    const before = titles(s);
    const archive = roundTrip(s);
    trashPages(s, topLevelPages(s).map((b) => b.id));
    expect(topLevelPages(s)).toHaveLength(0);
    const r = importArchiveRecords(s, archive);
    expect(titles(s)).toEqual(before);
    expect(r.keptNewer).toBe(0);
    expect(r.restored).toBe(3);
  });

  it("Danach bearbeitete Seiten bleiben (lokal neuer, nicht gelöscht)", () => {
    const { s } = sample();
    const archive = roundTrip(s);
    const beta = topLevelPages(s).find((b) => b.text === "Beta")!;
    s.transact("Rename", (tx) => tx.update(beta.id, (b) => { b.text = "Beta (edited)"; }));
    const r = importArchiveRecords(s, archive);
    expect(s.blocks.get(beta.id)?.text).toBe("Beta (edited)");
    expect(r.keptNewer).toBe(1);
    expect(r.restored).toBeUndefined();
  });

  it("Nach dem Export bearbeitet und dann in den Papierkorb gelegt: die neuere Fassung kommt zurück", () => {
    const { s } = sample();
    const archive = roundTrip(s);
    const beta = topLevelPages(s).find((b) => b.text === "Beta")!;
    s.transact("Rename", (tx) => tx.update(beta.id, (b) => { b.text = "Beta (edited)"; }));
    trashPages(s, [beta.id]);
    const r = importArchiveRecords(s, archive);
    const back = s.blocks.get(beta.id);
    expect(back?.trashedAt).toBeUndefined();
    expect(back?.text).toBe("Beta (edited)");
    expect(titles(s)).toContain("Beta (edited)");
    expect(r.restored).toBe(1);
  });

  it("Auf einem anderen Gerät gelöscht, hier importiert: der Sync bringt die Seiten zurück", () => {
    const { s } = sample();
    const archive = roundTrip(s);
    const other = store("o");
    other.applyRemote(s.allRecords());
    const keys = s.allRecords().filter((r) => r.kind !== "workspace").map(recordKey);
    trashPages(s, topLevelPages(s).map((b) => b.id));
    other.applyRemote(s.allRecords());
    emptyTrash(s);
    const gone = keys.filter((k) => s.record(k) === undefined);
    const stamps = new Map(gone.map((k) => [k, s.persistence!.tombstone(k)!] as const));
    // „other“ bekommt erst die Löschung, dann die Wiederherstellung: die Wiederherstellung gewinnt.
    other.applyRemote([], gone, stamps);
    expect(topLevelPages(other)).toHaveLength(0);
    importArchiveRecords(s, archive);
    other.applyRemote(s.allRecords());
    expect(titles(other)).toEqual(titles(s));
    expect(titles(other)).toHaveLength(3);
  });
});
