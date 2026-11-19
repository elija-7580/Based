// BSD-456: Migrations-Test alter Beta-Daten. Unter test/fixtures/beta/ liegt je Beta-Version ein Workspace im
// Speicherformat dieses Builds (based.sqlite, einmal mit und einmal ohne Property-Records) und daneben, was darin steht
// (<name>.json: Seiten, Blöcke, Datenbanken, Zeilen, Ansichten, Papierkorb, Dateiverweise). Der aktuelle Stand muss
// jede Datei öffnen (Migrationen laufen auf einer Kopie) und denselben Inhalt lesen. Der Test bleibt dauerhaft.
//
// Neue Beta-Version → Fixture dazulegen (mit dem Code des Release-Commits, z. B. in einem git worktree des Tags, in den
// diese Testdatei kopiert wird; schreibt auch das Based-Archiv <label>.based.zip):
//   BASED_WRITE_BETA_FIXTURE=beta-<sha> BASED_BETA_COMMIT=<sha> pnpm --filter @based/sync exec vitest run test/beta-fixtures.test.ts
// Dateien nie ändern oder löschen.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addOption, addProperty, addRow, addView, applyImportedRecords, archiveAssetRefs, createDatabase, createPage, isArchive, loadArchive, trashPages, WorkspaceStore, writeArchivePackage,
  type RichText, type WireRecord,
} from "@based/core";
import { openWorkspace } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import { CURRENT_SCHEMA_VERSION, schemaVersion } from "../src/migrations.js";

const DIR = fileURLToPath(new URL("./fixtures/beta/", import.meta.url));
const HASH = "b".repeat(64);
const plain = (t: RichText | undefined) => (t === undefined ? "" : typeof t === "string" ? t : t.map((r) => r.t ?? "").join(""));

/** Kleine, aber vollständige Welt: verschachtelte Seiten, Blocktypen, Datenbank mit Spalten/Zeilen/Ansichten, Datei, Papierkorb. */
export function buildBetaWorld(store: WorkspaceStore) {
  const home = createPage(store, { title: "Beta notes" });
  const child = createPage(store, { title: "Child page", parent: home });
  createPage(store, { title: "Grandchild", parent: child });
  const put = (id: string, type: string, parent: string, sk: string, text: string, props?: Record<string, unknown>) =>
    store.transact("fixture", (tx) => tx.put({ kind: "block", data: { id, type, parent: "b:" + parent, sk, createdAt: 0, updatedAt: 0, text, ...(props ? { props } : {}) } } as WireRecord));
  put("fx-h1", "heading1", home, "a0", "Heading");
  put("fx-p", "text", home, "a1", "Plain paragraph with ünïcödé and emoji 🙂");
  put("fx-todo", "todo", home, "a2", "A task", { checked: true });
  put("fx-bullet", "bulletedList", home, "a3", "Bullet");
  put("fx-toggle", "toggle", home, "a4", "Toggle");
  store.transact("fixture", (tx) => tx.put({ kind: "block", data: { id: "fx-in-toggle", type: "text", parent: "b:fx-toggle", sk: "a0", createdAt: 0, updatedAt: 0, text: "Inside the toggle" } } as WireRecord));
  put("fx-code", "code", home, "a5", "const x = 1;", { language: "typescript" });
  put("fx-img", "image", child, "a0", "", { asset: { id: HASH, name: "photo.png" } });
  const db = createDatabase(store, { parent: "b:" + home, title: "Tasks", inline: true, sampleRows: 0 });
  const status = addProperty(store, db.databaseID, "Stage", "select")!;
  const optOpen = addOption(store, db.databaseID, status, "Open")!;
  const optDone = addOption(store, db.databaseID, status, "Done")!;
  const points = addProperty(store, db.databaseID, "Points", "number")!;
  const done = addProperty(store, db.databaseID, "Checked", "checkbox")!;
  const note = addProperty(store, db.databaseID, "Note", "text")!;
  addRow(store, db.databaseID, { title: "First row", values: { [status]: { select: { _0: optOpen } }, [points]: { number: { _0: 3 } }, [note]: { text: { _0: "note one" } } } });
  addRow(store, db.databaseID, { title: "Second row", values: { [status]: { select: { _0: optDone } }, [points]: { number: { _0: 5 } }, [done]: { checkbox: { _0: true } } } });
  addView(store, db.blockID, "board", "Board");
  // ab beta-v0.2.9 (BSD-578): Datum ohne Uhrzeit trägt seinen Kalendertag (`day`), Datum mit Uhrzeit nicht.
  // Ältere Fixtures haben diese Datenbank nicht – jedes Fixture prüft gegen das, was es selbst beim Schreiben las.
  {
    const at = (y: number, m: number, d: number, h = 0) => (new Date(y, m - 1, d, h).getTime() - 978_307_200_000) / 1000;
    const dates = createDatabase(store, { parent: "b:" + home, title: "Dates", inline: true, sampleRows: 0 });
    const when = addProperty(store, dates.databaseID, "When", "date")!;
    addRow(store, dates.databaseID, { title: "Day only", values: { [when]: { date: { _0: { start: at(2026, 11, 23), includeTime: false } } } } as never });
    addRow(store, dates.databaseID, { title: "Range", values: { [when]: { date: { _0: { start: at(2026, 11, 23), end: at(2026, 11, 27), includeTime: false } } } } as never });
    addRow(store, dates.databaseID, { title: "With time", values: { [when]: { date: { _0: { start: at(2026, 11, 23, 9), includeTime: true } } } } as never });
  }
  const gone = createPage(store, { title: "In the trash" });
  trashPages(store, [gone]);
}

/** Was im Workspace steht – unabhängig vom Speicherformat (Property-Records oder Liste, Stempel, Zeiten). */
export function describeWorld(store: WorkspaceStore) {
  const blocks = [...store.blocks.values()];
  const byID = new Map(blocks.map((b) => [b.id, b]));
  const pathOf = (id: string): string => {
    const b = byID.get(id);
    if (!b) return "?";
    const parent = b.parent?.startsWith("b:") ? b.parent.slice(2) : undefined;
    const label = `${b.type}:${plain(b.text)}`;
    return parent ? `${pathOf(parent)} / ${label}` : label;
  };
  const dbs = [...store.databases.values()].map((d) => ({
    title: plain(d.title as RichText | undefined),
    properties: d.properties.map((p) => `${p.name}:${p.type}${p.options?.length ? `[${p.options.map((o) => o.name).join(",")}]` : ""}`).sort(),
    rows: store.children("d:" + d.id).map((rid) => {
      const r = byID.get(rid)!;
      const values = Object.fromEntries(Object.entries((r.values ?? {}) as Record<string, unknown>).map(([k, v]) => [d.properties.find((p) => p.id === k)?.name ?? k, v]));
      return { title: plain(r.text), values };
    }).sort((a, b) => a.title.localeCompare(b.title)),
    views: [...store.views.values()].filter((v) => v.databaseID === d.id).map((v) => v.type).sort(),
  })).sort((a, b) => a.title.localeCompare(b.title));
  return {
    workspace: store.workspace.name,
    blocks: blocks.filter((b) => !b.parent?.startsWith("d:")).map((b) => `${pathOf(b.id)}${b.trashedAt ? " (trash)" : ""}${b.checked ? " [x]" : ""}`).sort(),
    databases: dbs,
    assets: archiveAssetRefs(store.exportRecords()).map((a) => `${a.id}:${a.name ?? ""}`).sort(),
  };
}

const writeLabel = process.env.BASED_WRITE_BETA_FIXTURE;

describe("BSD-456: Beta-Fixtures erzeugen", () => {
  it.runIf(Boolean(writeLabel))("schreibt test/fixtures/beta/<label>{,-records}.sqlite + .json", () => {
    mkdirSync(DIR, { recursive: true });
    for (const records of [false, true]) {
      const name = `${writeLabel}${records ? "-records" : ""}`;
      const file = join(DIR, `${name}.sqlite`);
      if (existsSync(file)) throw new Error(`${file} exists – fixtures are never overwritten`);
      const sql = openNodeDatabase(file);
      const { store } = openWorkspace(sql, { node: "BETAFIXTURE", propertyRecords: records });
      buildBetaWorld(store);
      sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      sql.exec("PRAGMA journal_mode = DELETE");
      writeFileSync(join(DIR, `${name}.json`), JSON.stringify({ label: writeLabel, commit: process.env.BASED_BETA_COMMIT ?? "", schemaVersion: schemaVersion(sql), propertyRecords: records, expect: describeWorld(store) }, null, 2) + "\n");
    }
    // Based-Archiv dieses Builds (Sicherung vor dem Update, Export) aus einer neuen Datei mit den Vorgaben des Builds
    const zip = join(DIR, `${writeLabel}.based.zip`);
    if (existsSync(zip)) throw new Error(`${zip} exists – fixtures are never overwritten`);
    const tmp = mkdtempSync(join(tmpdir(), "based-beta-write-"));
    try {
      const sql = openNodeDatabase(join(tmp, "based.sqlite"));
      const { store } = openWorkspace(sql, { node: "BETAFIXTURE" });
      buildBetaWorld(store);
      const pkg = writeArchivePackage(store, (ref) => (ref.id === HASH ? new Uint8Array([137, 80, 78, 71]) : undefined));
      writeFileSync(zip, pkg.zip);
      writeFileSync(join(DIR, `${writeLabel}.based.json`), JSON.stringify({ label: writeLabel, commit: process.env.BASED_BETA_COMMIT ?? "", archive: true, schemaVersion: schemaVersion(sql), propertyRecords: store.propertyRecords, expect: describeWorld(store) }, null, 2) + "\n");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("BSD-456: alte Beta-Daten öffnen (Migrations-Test)", () => {
  const fixtures = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".sqlite")).sort() : [];

  it("mindestens das Fixture des ersten Beta-Builds liegt vor", () => {
    expect(fixtures).toContain("beta-9614eb09.sqlite");
    expect(fixtures).toContain("beta-9614eb09-records.sqlite");
  });

  for (const f of fixtures) {
    it(`${f}: öffnet mit dem aktuellen Stand, Inhalt unverändert, Archiv-Rundreise vollständig`, () => {
      const meta = JSON.parse(readFileSync(join(DIR, f.replace(/\.sqlite$/, ".json")), "utf8")) as { schemaVersion: number; propertyRecords: boolean; expect: ReturnType<typeof describeWorld> };
      const tmp = mkdtempSync(join(tmpdir(), "based-beta-fixture-"));
      try {
        const copy = join(tmp, "based.sqlite");
        copyFileSync(join(DIR, f), copy);
        const sql = openNodeDatabase(copy);
        expect(schemaVersion(sql)).toBe(meta.schemaVersion);
        const { store } = openWorkspace(sql, { node: "NEWDEVICE" });
        // Property-Records heben die Version zusätzlich (enablePropertyRecords); nie unter dem aktuellen Stand
        expect(schemaVersion(sql)).toBeGreaterThanOrEqual(Math.max(CURRENT_SCHEMA_VERSION, meta.schemaVersion));
        // Datei mit Property-Records bleibt dabei; eine ohne wird umgestellt, wenn das die Vorgabe ist (beide Datenformate)
        expect(store.propertyRecords).toBe(meta.propertyRecords || WorkspaceStore.propertyRecordsByDefault);
        expect(describeWorld(store)).toEqual(meta.expect);
        // Sicherung vor dem Update (Based-Archiv) und Wiederherstellen: dieselbe Welt, Datei inklusive
        const bytes = new Uint8Array([137, 80, 78, 71]);
        const pkg = writeArchivePackage(store, (ref) => (ref.id === HASH ? bytes : undefined));
        expect(pkg.missing).toEqual([]);
        expect(isArchive(pkg.zip)).toBe(true);
        const fresh = new WorkspaceStore({ node: "RESTORE" });
        const loaded = loadArchive(pkg.zip);
        expect(loaded.assets.map((a) => [a.ref.id, a.data])).toEqual([[HASH, bytes]]);
        applyImportedRecords(fresh, loaded.read.records);
        expect(describeWorld(fresh)).toEqual({ ...meta.expect, workspace: fresh.workspace.name });
        // Nachtlauf 19.11. (Go/No-Go „Update behält die Daten“): nach dem ersten Start mit dem neuen Stand eine Änderung,
        // dann der zweite Start – die umgestellte Datei liest dieselbe Welt plus die Änderung
        createPage(store, { title: "After the update" });
        sql.close();
        const again = openNodeDatabase(copy);
        try {
          const reopened = openWorkspace(again, { node: "NEWDEVICE" }).store;
          expect(reopened.propertyRecords).toBe(store.propertyRecords);
          expect(describeWorld(reopened)).toEqual({ ...meta.expect, blocks: [...meta.expect.blocks, "page:After the update"].sort() });
        } finally {
          again.close();
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});

// Nachtlauf 19.11.: Based-Archive, die ein alter Beta-Build geschrieben hat (Sicherung vor dem Update, Export).
// docs/data-format.md: „Eine neuere App liest jedes ältere Archiv.“ Erzeugt mit dem Code des jeweiligen Builds
// (packages/core + packages/sync per git archive, Welt aus buildBetaWorld, Datei mit 4 Bytes). Dateien nie ändern.
// 9614eb09 = Stand von beta-v0.2.2, 73d82082 = beta-v0.2.3/0.2.4, b4fd1095 = 0.2.5/0.2.6, d6d1a875 = 0.2.7,
// 363e5d88 = 0.2.8, 9d9afc9a = 0.2.9, 1ff6eff1 = 0.2.10 (die SQLite-Fixtures daneben stammen aus denselben Builds;
// ab 0.2.9 mit Datums-Spalte und das Archiv aus einer neuen Datei, also mit Property-Records).
describe("Nachtlauf 19.11.: Archive alter Beta-Builds wieder einspielen", () => {
  const archives = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".based.zip")).sort() : [];

  it("das Archiv des ersten Beta-Builds liegt vor", () => {
    expect(archives).toContain("beta-9614eb09.based.zip");
  });

  for (const f of archives) {
    it(`${f}: Import in einen leeren Workspace liest denselben Inhalt`, () => {
      const meta = JSON.parse(readFileSync(join(DIR, f.replace(/\.zip$/, ".json")), "utf8")) as { expect: ReturnType<typeof describeWorld> };
      const loaded = loadArchive(readFileSync(join(DIR, f)));
      expect(loaded.assetFailures).toEqual([]);
      expect(loaded.read.skipped).toBe(0);
      expect(loaded.assets.map((a) => [a.ref.id, [...a.data]])).toEqual([[HASH, [137, 80, 78, 71]]]);
      const fresh = new WorkspaceStore({ node: "RESTORE" });
      applyImportedRecords(fresh, loaded.read.records);
      expect(describeWorld(fresh)).toEqual({ ...meta.expect, workspace: fresh.workspace.name });
      // und in eine Datei des aktuellen Stands (beide Datenformate), wieder geöffnet
      const tmp = mkdtempSync(join(tmpdir(), "based-beta-archive-"));
      try {
        const sql = openNodeDatabase(join(tmp, "based.sqlite"));
        const { store } = openWorkspace(sql, { node: "NEWDEVICE" });
        applyImportedRecords(store, loaded.read.records);
        expect(describeWorld(store)).toEqual({ ...meta.expect, workspace: store.workspace.name });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
