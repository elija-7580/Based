// BSD-30 (ADR 0014): Server mit Properties als eigenen Records – Protokoll 3, Sperre für alte Clients, zwei Geräte
// über echtes HTTP, Umstellung einer bestehenden Server-Datei, Gäste.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createPage, dbops, keyOf, type Database } from "@based/core";
import { hasPropertyRecords, openWorkspace, revertPropertyRecords, schemaVersion, SyncClient } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { startApp, TOKEN } from "./helpers.js";

let apps: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close().catch(() => undefined)));
  apps = [];
});

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tempFile = () => {
  const d = mkdtempSync(join(tmpdir(), "based-props-"));
  dirs.push(d);
  return join(d, "based.sqlite");
};

async function start(opts: { propertyRecords?: boolean; db?: string } = {}) {
  const app = await startApp({ propertyRecords: opts.propertyRecords ?? true, ...(opts.db ? { db: opts.db } : {}) });
  apps.push(app);
  return app;
}
const device = (propertyRecords = true) => openWorkspace(openNodeDatabase(), { propertyRecords });
const client = (d: ReturnType<typeof device>, url: string, token = TOKEN) => new SyncClient(d.store, d.persistence, { baseURL: url, token });
const h = (protocol?: number) => ({ Authorization: `Bearer ${TOKEN}`, ...(protocol ? { "X-Based-Protocol": String(protocol) } : {}) });

describe("Protokoll 3 und die Sperre", () => {
  it("umgestellter Server meldet Protokoll 3 und weist Clients ohne oder mit altem Protokoll ab (Lesen und Schreiben)", async () => {
    const app = await start();
    expect(await (await fetch(`${app.url}/health`)).json()).toMatchObject({ ok: true, protocol: 3 });
    expect(await (await fetch(`${app.url}/sync/v2/info`, { headers: h() })).json()).toMatchObject({ protocol: 3 });
    for (const headers of [h(), h(2)]) {
      const pull = await fetch(`${app.url}/sync/v2/pull?after=0`, { headers });
      expect(pull.status).toBe(426);
      expect(((await pull.json()) as { error: string }).error).toMatch(/newer Based/);
      expect((await fetch(`${app.url}/sync/v2/push`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ records: [], deletions: [] }) })).status).toBe(426);
      expect((await fetch(`${app.url}/sync/v2/wait?after=0&timeout=0`, { headers })).status).toBe(426);
      expect((await fetch(`${app.url}/sync/pull`, { headers })).status).toBe(426);
      expect((await fetch(`${app.url}/sync/push`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "{}" })).status).toBe(426);
    }
    expect((await fetch(`${app.url}/sync/v2/pull?after=0`, { headers: h(3) })).status).toBe(200);
    // ohne Token weiterhin 401, nicht 426 (die Sperre verrät nichts)
    expect((await fetch(`${app.url}/sync/v2/pull?after=0`)).status).toBe(401);
  });

  it("ein altes Gerät (Sync-Client im alten Format) bekommt nichts und schreibt nichts", async () => {
    const app = await start();
    const neu = device();
    const page = createPage(neu.store, { title: "Home" });
    const db = dbops.createDatabase(neu.store, { parent: "b:" + page, title: "Tasks", sampleRows: 0 }).databaseID;
    await client(neu, app.url).syncOnce();
    expect(app.sync.store.databases.get(db)!.properties.length).toBeGreaterThan(0);

    const old = device(false);
    const oldPage = createPage(old.store, { title: "Old page" });
    await expect(client(old, app.url).syncOnce()).rejects.toThrow(/426/);
    expect(old.store.databases.size).toBe(0);
    expect(app.sync.store.blocks.has(oldPage)).toBe(false);
  });

  it("ein neues Gerät gegen einen alten Server: 409, nichts wird übertragen", async () => {
    const app = await start({ propertyRecords: false });
    expect(app.sync.protocol).toBe(2);
    const neu = device();
    const page = createPage(neu.store, { title: "Home" });
    await expect(client(neu, app.url).syncOnce()).rejects.toThrow(/409/);
    expect(app.sync.store.blocks.has(page)).toBe(false);
  });
});

describe("zwei Geräte über den Server", () => {
  it("gleichzeitig verschiedene Spalten geändert: nach dem Abgleich haben Server und beide Geräte beide Änderungen", async () => {
    const app = await start();
    const a = device(), b = device();
    const ca = client(a, app.url), cb = client(b, app.url);
    const page = createPage(a.store, { title: "Home" });
    const db = dbops.createDatabase(a.store, { parent: "b:" + page, title: "Tasks" }).databaseID;
    const notes = dbops.addProperty(a.store, db, "Notes", "text")!, status = dbops.addProperty(a.store, db, "Status", "select")!;
    await ca.syncOnce();
    await cb.syncOnce();
    expect(b.store.databases.get(db)).toEqual(a.store.databases.get(db));

    // beide offline geändert
    dbops.renameProperty(a.store, db, notes, "Remarks");
    dbops.addOption(b.store, db, status, "Open");
    const due = dbops.addProperty(b.store, db, "Due", "date")!;
    await ca.syncOnce();
    await cb.syncOnce();
    await ca.syncOnce();
    for (const s of [a.store, b.store, app.sync.store]) {
      const d = s.databases.get(db)!;
      expect(d.properties.find((p) => p.id === notes)!.name).toBe("Remarks");
      expect(d.properties.find((p) => p.id === status)!.options!.map((o) => o.name)).toEqual(["Open"]);
      expect(d.properties.some((p) => p.id === due)).toBe(true);
    }
    expect(a.store.databases.get(db)).toEqual(b.store.databases.get(db));
    expect(app.sync.store.databases.get(db)).toEqual(a.store.databases.get(db));

    // Spalte löschen kommt überall an; Zeilen und Ansichten bleiben
    const rows = a.store.children("d:" + db).length;
    dbops.deleteProperty(a.store, db, due);
    await ca.syncOnce();
    await cb.syncOnce();
    for (const s of [b.store, app.sync.store]) {
      expect(s.databases.get(db)!.properties.some((p) => p.id === due)).toBe(false);
      expect(s.children("d:" + db)).toHaveLength(rows);
    }
    // neu geöffnet (aus der Datei): derselbe Stand
    const reopened = openWorkspace(b.persistence.db);
    expect(reopened.store.propertyRecords).toBe(true);
    expect(reopened.store.databases.get(db)).toEqual(b.store.databases.get(db));
  });
});

describe("Umstellung einer bestehenden Datei", () => {
  it("Server-Datei im alten Format: Kopie der Datenbank-Records, Version 4, Sicht unverändert; ohne Option bleibt sie umgestellt", async () => {
    const path = tempFile();
    let file = openNodeDatabase(path);
    const before = openWorkspace(file, { node: "server", propertyRecords: false });
    const page = createPage(before.store, { title: "Home" });
    const db = dbops.createDatabase(before.store, { parent: "b:" + page, title: "Tasks" }).databaseID;
    dbops.addProperty(before.store, db, "Notes", "text");
    const view = structuredClone(before.store.databases.get(db)!);
    const rows = before.store.children("d:" + db).map((id) => structuredClone(before.store.blocks.get(id)!));
    expect(schemaVersion(file)).toBe(3);
    expect(hasPropertyRecords(file)).toBe(false);
    file.close();

    const app = await start({ db: path });
    expect(app.sync.protocol).toBe(3);
    expect(schemaVersion(app.sync.db)).toBe(4);
    expect(app.sync.store.databases.get(db)).toEqual(view);
    expect(app.sync.store.children("d:" + db).map((id) => app.sync.store.blocks.get(id))).toEqual(rows);
    // Kopie des alten Records liegt in der Datei
    const backup = app.sync.db.all("SELECT id, data FROM property_migration_backup");
    expect(backup).toHaveLength(1);
    const old = JSON.parse(new TextDecoder().decode(backup[0]!.data as Uint8Array)) as Database;
    expect(old.properties).toEqual(view.properties);
    // gespeichert: Kern ohne Properties, mit eingefrorener Liste
    const core = app.sync.store.record(keyOf("database", db))!.data as Database & { legacyProperties?: unknown };
    expect(core.properties).toEqual([]);
    expect(core.legacyProperties).toEqual(view.properties);
    await app.close();
    apps = [];

    // ohne die Option geöffnet: bleibt im neuen Format (sonst hätten die Datenbanken keine Spalten)
    file = openNodeDatabase(path);
    const again = openWorkspace(file, { node: "server", propertyRecords: false });
    expect(again.store.propertyRecords).toBe(true);
    expect(again.store.databases.get(db)).toEqual(view);
    expect(file.all("SELECT id FROM property_migration_backup")).toHaveLength(1);
  });

  it("ein Gerät, das vor seiner Umstellung noch eine Spalte geändert hat, bringt die Änderung mit", async () => {
    const serverPath = tempFile();
    const app = await start({ propertyRecords: false, db: serverPath });
    const file = openNodeDatabase();
    const old = openWorkspace(file, { propertyRecords: false });
    const page = createPage(old.store, { title: "Home" });
    const db = dbops.createDatabase(old.store, { parent: "b:" + page, title: "Tasks", sampleRows: 0 }).databaseID;
    const notes = dbops.addProperty(old.store, db, "Notes", "text")!;
    await client(old, app.url).syncOnce();
    // noch nicht übertragen
    dbops.renameProperty(old.store, db, notes, "Renamed before the switch");
    await app.close();
    apps = [];

    const migrated = await start({ db: serverPath });
    const now = openWorkspace(file, { propertyRecords: true });
    await client(now, migrated.url).syncOnce();
    expect(migrated.sync.store.databases.get(db)!.properties.find((p) => p.id === notes)!.name).toBe("Renamed before the switch");
    expect(now.store.databases.get(db)).toEqual(migrated.sync.store.databases.get(db));
  });
});

describe("Gäste", () => {
  it("ein Gast mit Bearbeiten-Link sieht die Spalten der geteilten Datenbank, keine fremden, und kann eine Spalte ändern", async () => {
    const app = await start();
    const s = app.sync.store;
    const shared = createPage(s, { title: "Shared" });
    const priv = createPage(s, { title: "Private" });
    const tasks = dbops.createDatabase(s, { parent: "b:" + shared, title: "Tasks", sampleRows: 0 }).databaseID;
    const notes = dbops.addProperty(s, tasks, "Notes", "text")!;
    const secret = dbops.createDatabase(s, { parent: "b:" + priv, title: "Secret", sampleRows: 0 }).databaseID;
    const salary = dbops.addProperty(s, secret, "Salary", "number")!;
    const link = app.share.createLink("access", shared, "edit", { kind: "owner" });
    const guest = device();
    const cg = client(guest, app.url, link.secret!);
    await cg.syncOnce();
    expect(guest.store.databases.get(tasks)!.properties.map((p) => p.name)).toContain("Notes");
    expect(guest.store.databases.has(secret)).toBe(false);
    expect([...guest.store.properties.values()].every((p) => p.databaseID === tasks)).toBe(true);

    dbops.renameProperty(guest.store, tasks, notes, "Guest renamed");
    await cg.syncOnce();
    expect(s.databases.get(tasks)!.properties.find((p) => p.id === notes)!.name).toBe("Guest renamed");

    // fremde Property überschreiben oder in den eigenen Bereich ziehen: abgelehnt
    const foreign = s.properties.get(`${secret}/${salary}`)!;
    const push = (data: unknown) => fetch(`${app.url}/sync/v2/push`, {
      method: "POST", headers: { Authorization: `Bearer ${link.secret}`, "X-Based-Protocol": "3", "Content-Type": "application/json" },
      body: JSON.stringify({ records: [{ kind: "property", data }], deletions: [] }),
    });
    const future = { millis: Date.now() + 1000, counter: 0, node: "guest" };
    await push({ ...foreign, schema: { ...foreign.schema, name: "Hacked" }, stamp: future });
    await push({ ...foreign, databaseID: tasks, stamp: future });
    expect(s.databases.get(secret)!.properties.find((p) => p.id === salary)!.name).toBe("Salary");
    expect(s.databases.get(tasks)!.properties.some((p) => p.id === salary)).toBe(false);
    // und löschen ebenso wenig
    await fetch(`${app.url}/sync/v2/push`, {
      method: "POST", headers: { Authorization: `Bearer ${link.secret}`, "X-Based-Protocol": "3", "Content-Type": "application/json" },
      body: JSON.stringify({ records: [], deletions: [{ kind: "property", id: foreign.id, stamp: future }] }),
    });
    expect(s.properties.has(foreign.id)).toBe(true);
  });
});

describe("Rückweg", () => {
  it("revertPropertyRecords: altes Format mit dem aktuellen Stand, auch Änderungen seit der Umstellung; danach wieder Protokoll 2", async () => {
    const path = tempFile();
    let file = openNodeDatabase(path);
    const old = openWorkspace(file, { node: "server", propertyRecords: false });
    const page = createPage(old.store, { title: "Home" });
    const db = dbops.createDatabase(old.store, { parent: "b:" + page, title: "Tasks" }).databaseID;
    const notes = dbops.addProperty(old.store, db, "Notes", "text")!;
    const rows = old.store.children("d:" + db).length;
    file.close();

    file = openNodeDatabase(path);
    const split = openWorkspace(file, { node: "server", propertyRecords: true });
    dbops.renameProperty(split.store, db, notes, "Changed after the switch");
    const due = dbops.addProperty(split.store, db, "Due", "date")!;
    const view = structuredClone(split.store.databases.get(db)!);
    expect(revertPropertyRecords(file)).toBe(1);
    expect(schemaVersion(file)).toBe(3);
    expect(file.all("SELECT id FROM records WHERE kind = 'property'")).toEqual([]);
    expect(file.all("SELECT id FROM changes WHERE kind = 'property'")).toEqual([]);
    expect(revertPropertyRecords(file)).toBe(0);
    file.close();

    const app = await start({ propertyRecords: false, db: path });
    expect(app.sync.protocol).toBe(2);
    const back = app.sync.store.databases.get(db)!;
    expect(back.properties).toEqual(view.properties);
    expect(back.properties.find((p) => p.id === notes)!.name).toBe("Changed after the switch");
    expect(back.properties.some((p) => p.id === due)).toBe(true);
    expect("legacyProperties" in back).toBe(false);
    expect(app.sync.store.children("d:" + db)).toHaveLength(rows);
    expect(app.sync.store.allRecords().some((r) => r.kind === "property")).toBe(false);
  });
});
