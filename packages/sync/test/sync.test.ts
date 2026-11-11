// BSD-152: lokaler Speicher (Migrationen, Change-Log, Schreibfehler) und Sync-v2-Client gegen einen Server.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalStringify, encodeRecord, keyOf, parseRecord, recordKey, type WireRecord, WorkspaceStore } from "@based/core";
import {
  CURRENT_SCHEMA_VERSION,
  openWorkspace,
  PersistenceError,
  PULLED_KEY,
  PUSHED_KEY,
  schemaVersion,
  SqlitePersistence,
  SyncClient,
  type SqlDatabase,
} from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import { openWasmDatabase } from "../src/drivers/wasm.js";
import { FakeServer } from "./fake-server.js";

// Diese Datei prüft das alte Format (Properties im Datenbank-Record, Protokoll 2) – auch wenn die Suite sonst mit
// BASED_PROPERTY_RECORDS=1 läuft (BSD-30).
WorkspaceStore.propertyRecordsByDefault = false;

const corpusFile = fileURLToPath(new URL("../../../fixtures/records/corpus.jsonl", import.meta.url));
// Ein Workspace pro Datei (BSD-23): der zweite Workspace-Record des Korpus gehört in keinen echten Workspace.
const corpus = readFileSync(corpusFile, "utf8").split("\n").filter((l) => l.length > 0 && !l.includes('"id":"workspace-2"'));

const block = (id: string, parent = "w", text = id): WireRecord => ({
  kind: "block",
  data: { id, type: "page", parent, sk: "a0", text, createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "x" } },
});

function device(db: SqlDatabase = openNodeDatabase(), node?: string) {
  const { store, persistence } = openWorkspace(db, node ? { node } : {});
  return { store, persistence, db };
}

function client(d: { store: WorkspaceStore; persistence: SqlitePersistence }, server: FakeServer, pageSize = 500) {
  return new SyncClient(d.store, d.persistence, { baseURL: "https://based.test/", token: server.token, fetch: server.fetch, pageSize });
}

const snapshot = (s: WorkspaceStore) =>
  s
    .allRecords()
    .filter((r) => r.data.stamp && (r.data.stamp as { millis: number }).millis > 0)
    .map((r) => canonicalStringify(r))
    .sort();

const createPage = (s: WorkspaceStore, id: string, text = id) =>
  s.transact("New page", (tx) => tx.put(block(id, "w", text)));
/** Endgültig löschen (Seiten gehen sonst nur in den Papierkorb). */
const deleteForever = (s: WorkspaceStore, id: string) => s.transact("Delete forever", (tx) => tx.remove(keyOf("block", id)));

describe("Migrationen", () => {
  it("neue Datei bekommt v3, Tabellen und Gerätekennung", () => {
    const d = device();
    expect(schemaVersion(d.db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(3);
    expect(d.persistence.meta("node")).toMatch(/^[0-9A-F]{8}$/);
    expect(d.store.clock.node).toBe(d.persistence.meta("node"));
  });

  it("Datei von vor der Liste (v0): Change-Log aus den Records, Sicherung daneben", () => {
    const dir = mkdtempSync(join(tmpdir(), "based-mig-"));
    const path = join(dir, "based.sqlite");
    const raw = openNodeDatabase(path);
    raw.exec(`CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(kind, id));
              CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB);`);
    raw.run("INSERT INTO records VALUES('block','a',?)", [new TextEncoder().encode(JSON.stringify(block("a").data))]);
    raw.close();
    const d = device(openNodeDatabase(path));
    expect(d.store.blocks.get("a")?.text).toBe("a");
    expect(d.persistence.changes(0, 10).map((e) => [e.key, e.local])).toEqual([["block:a", true]]);
    expect(readdirSync(dir)).toContain("based.sqlite.bak-v0");
    expect(d.persistence.meta("migration.backup")).toBe(path + ".bak-v0");
  });

  it("zwei Workspace-Zeilen: der neuere bleibt, der andere geht in die Quarantäne", () => {
    const raw = openNodeDatabase();
    raw.exec(`CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL, PRIMARY KEY(kind, id));
              CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB); PRAGMA user_version = 1;
              CREATE TABLE changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, id TEXT NOT NULL,
                                    deleted INTEGER NOT NULL DEFAULT 0, local INTEGER NOT NULL DEFAULT 1);`);
    const ws = (id: string, millis: number) => JSON.stringify({ id, name: id, favorites: [], createdAt: 0, updatedAt: 0, stamp: { millis, counter: 0, node: "n" } });
    raw.run("INSERT INTO records VALUES('workspace','workspace',?)", [ws("workspace", 1)]);
    raw.run("INSERT INTO records VALUES('workspace','other',?)", [ws("other", 9)]);
    const d = device(raw);
    expect(d.store.workspace.id).toBe("other");
    expect(raw.all("SELECT id, reason FROM quarantine")).toEqual([{ id: "workspace", reason: "duplicate workspace record (kept other)" }]);
  });

  it("neueres Format wird nicht geöffnet und nicht angefasst", () => {
    const raw = openNodeDatabase();
    raw.exec("PRAGMA user_version = 99");
    expect(() => new SqlitePersistence(raw)).toThrow(PersistenceError);
    expect(raw.all("SELECT name FROM sqlite_master")).toEqual([]);
  });
});

describe("Lokaler Speicher", () => {
  it("überlebt einen Neustart: Records, Tombstone-Stempel, Cursor", () => {
    const path = join(mkdtempSync(join(tmpdir(), "based-p-")), "based.sqlite");
    const a = device(openNodeDatabase(path));
    createPage(a.store, "p1");
    createPage(a.store, "p2");
    deleteForever(a.store, "p2");
    a.persistence.setMeta(PUSHED_KEY, "7");
    a.db.close();
    const b = device(openNodeDatabase(path));
    expect([...b.store.blocks.keys()]).toEqual(["p1"]);
    expect(b.persistence.tombstone(keyOf("block", "p2"))).toBeDefined();
    expect(b.persistence.metaInt(PUSHED_KEY)).toBe(7);
    expect(b.store.clock.node).toBe(a.store.clock.node);
  });

  it("unlesbare Zeilen bleiben in der Datei und werden nie gepusht", async () => {
    const d = device();
    d.db.run("INSERT INTO records VALUES('block','broken',?)", [new TextEncoder().encode("{kaputt")]);
    d.db.run("INSERT INTO changes(kind, id, deleted, local) VALUES('block','broken',0,1)");
    const again = device(d.db);
    expect(again.persistence.undecodable.map((u) => u.key)).toEqual(["block:broken"]);
    const server = new FakeServer();
    await client(again, server).syncOnce();
    expect(server.keys()).not.toContain("block:broken");
    expect(d.db.all("SELECT id FROM records WHERE id = 'broken'")).toHaveLength(1);
  });

  it("Schreibfehler: Änderung zurückgedreht, Store schreibgeschützt, Sync pausiert, Retry hebt es auf", async () => {
    const d = device();
    createPage(d.store, "p1");
    const real = d.db.run.bind(d.db);
    let broken = true;
    d.db.run = (sql, params) => {
      if (broken && sql.startsWith("INSERT OR REPLACE INTO records")) throw new Error("disk I/O error");
      real(sql, params);
    };
    createPage(d.store, "p2");
    expect(d.store.blocks.has("p2")).toBe(false);
    expect(d.store.isReadOnly).toBe(true);
    expect(d.store.writeFailure?.message).toContain("disk I/O error");
    createPage(d.store, "p3");
    expect(d.store.blocks.has("p3")).toBe(false);
    expect(d.store.writeFailure?.rejected).toBe(2);

    const server = new FakeServer();
    const c = client(d, server);
    await c.syncNow();
    expect(c.lastError).toBe("read-only");
    expect(server.requests).toEqual([]);

    broken = false;
    expect(d.store.retryWrites()).toBe(true);
    await c.syncNow();
    expect(server.keys()).toContain("block:p1");
  });
});

describe("Sync v2", () => {
  it("echter Workspace (Swift-Korpus) wandert über den Server byte-gleich in einen zweiten Client", async () => {
    const server = new FakeServer();
    const records = corpus.map((l) => parseRecord(JSON.parse(l)));
    // Wie eine von der Swift-App geschriebene based.sqlite: alles als lokale Änderung im Log.
    const swiftFile = openNodeDatabase();
    new SqlitePersistence(swiftFile).write(records, [], new Map(), true);
    const a = device(swiftFile);
    await client(a, server, 7).syncOnce();

    const b = device();
    const r = await client(b, server, 5).syncOnce();
    expect(r.received).toBe(records.length);
    const byKey = new Map(b.store.allRecords().map((x) => [recordKey(x), x]));
    for (const line of corpus) {
      const original = parseRecord(JSON.parse(line));
      expect(encodeRecord(byKey.get(recordKey(original))!), recordKey(original)).toBe(line);
    }
    // Und zurück: B pusht nichts (alles kam per Sync), der Server bleibt unverändert.
    const before = server.persistence.maxSeq();
    const back = await client(b, server).syncOnce();
    expect(back.pushed).toBe(0);
    expect(server.persistence.maxSeq()).toBe(before);
  });

  it("offline bearbeiten, wieder online: der andere Client sieht die Änderung", async () => {
    const server = new FakeServer();
    const a = device(), b = device();
    const ca = client(a, server), cb = client(b, server);
    createPage(a.store, "p1", "Hallo");
    await ca.syncNow();
    await cb.syncNow();
    expect(b.store.blocks.get("p1")?.text).toBe("Hallo");

    server.offline = true;
    a.store.setText("p1", "Offline geändert");
    createPage(a.store, "p2", "Neu offline");
    await ca.syncNow();
    expect(ca.lastError).toContain("offline");
    server.offline = false;

    await ca.syncNow();
    expect(ca.lastError).toBeUndefined();
    await cb.syncNow();
    expect(b.store.blocks.get("p1")?.text).toBe("Offline geändert");
    expect(b.store.blocks.get("p2")?.text).toBe("Neu offline");
    expect(snapshot(b.store)).toEqual(snapshot(a.store));
  });

  it("Löschung mit Tombstone: neuere Löschung gewinnt, neuere Bearbeitung gewinnt gegen ältere Löschung", async () => {
    const server = new FakeServer();
    const a = device(), b = device();
    const ca = client(a, server), cb = client(b, server);
    createPage(a.store, "p1");
    createPage(a.store, "p2");
    await ca.syncNow();
    await cb.syncNow();

    // p1: B bearbeitet zuerst, A löscht später → gelöscht. p2: A löscht zuerst, B bearbeitet später → bleibt.
    b.store.clock.wallClock = () => Date.now() + 1000;
    a.store.clock.wallClock = () => Date.now() + 2000;
    b.store.setText("p1", "B früher");
    deleteForever(a.store, "p1");
    a.store.clock.wallClock = () => Date.now() + 3000;
    b.store.clock.wallClock = () => Date.now() + 4000;
    deleteForever(a.store, "p2");
    b.store.setText("p2", "B später");

    await ca.syncNow();
    await cb.syncNow();
    await ca.syncNow();
    expect(a.store.blocks.has("p1")).toBe(false);
    expect(b.store.blocks.has("p1")).toBe(false);
    expect(a.store.blocks.get("p2")?.text).toBe("B später");
    expect(b.store.blocks.get("p2")?.text).toBe("B später");
    expect(server.store.blocks.has("p1")).toBe(false);
  });

  it("Push-Antwort `newer`: der Server hat eine neuere Version", async () => {
    const server = new FakeServer();
    const a = device(), b = device();
    createPage(a.store, "p1", "alt");
    await client(a, server).syncNow();
    await client(b, server).syncNow();
    b.store.clock.wallClock = () => Date.now() + 10_000;
    b.store.setText("p1", "neu von B");
    await client(b, server).syncNow();
    a.store.setText("p1", "älter von A");
    const r = await client(a, server).syncOnce();
    expect(r.pushed).toBe(1);
    expect(a.store.blocks.get("p1")?.text).toBe("neu von B");
  });

  it("kein Zurückpushen: Angekommenes ist nicht lokal", async () => {
    const server = new FakeServer();
    const a = device(), b = device();
    createPage(a.store, "p1");
    await client(a, server).syncNow();
    await client(b, server).syncNow();
    expect(b.persistence.changes(0, 10).every((e) => !e.local)).toBe(true);
    const pushes = server.requests.filter((r) => r.includes("push")).length;
    await client(b, server).syncNow();
    expect(server.requests.filter((r) => r.includes("push")).length).toBe(pushes);
  });

  it("Seiten: viele Änderungen mit kleiner Seitengröße, Cursor stimmen", async () => {
    const server = new FakeServer();
    const a = device(), b = device();
    a.store.transact("viele", (tx) => {
      for (let i = 0; i < 23; i++) tx.put(block(`p${i}`));
    });
    await client(a, server, 4).syncOnce();
    expect(a.persistence.metaInt(PUSHED_KEY)).toBe(a.persistence.maxSeq());
    const r = await client(b, server, 3).syncOnce();
    expect(r.received).toBe(23);
    expect(b.persistence.metaInt(PULLED_KEY)).toBe(server.persistence.maxSeq());
  });

  it("Tombstone-GC auf dem Server: Gerät hinter oldestSeq holt alles neu und löscht Verschwundenes", async () => {
    const server = new FakeServer();
    const a = device(), b = device();
    createPage(a.store, "p1");
    createPage(a.store, "p2");
    await client(a, server).syncNow();
    await client(b, server).syncNow();
    deleteForever(a.store, "p2");
    createPage(a.store, "p3");
    await client(a, server).syncNow();
    server.compactTombstones();
    // B war lange offline und hat in der Zeit selbst etwas angelegt.
    createPage(b.store, "b1");
    const r = await client(b, server).syncOnce();
    expect(r.fullPull).toBe(true);
    expect([...b.store.blocks.keys()].sort()).toEqual(["b1", "p1", "p3"]);
    expect(server.store.blocks.has("b1")).toBe(true);
  });

  it("BSD-220: abgeleitete Änderungen (Echtzeit-Text) werden gespeichert, nicht gepusht, beim Voll-Pull behalten", async () => {
    const server = new FakeServer();
    const a = device(), b = device();
    createPage(a.store, "p1");
    await client(a, server).syncNow();
    await client(b, server).syncNow();
    deleteForever(a.store, "p1");
    createPage(a.store, "p2");
    await client(a, server).syncNow();
    server.compactTombstones();
    b.store.transact("Edit", (tx) => tx.put(block("y1", "w", "aus dem Y.Doc")), { derived: true });
    expect(b.persistence.changes(0, 100).find((e) => e.key === "block:y1")).toMatchObject({ local: false, derived: true });
    expect(b.persistence.derivedKeys()).toEqual(["block:y1"]);
    const r = await client(b, server).syncOnce();
    expect(r.pushed).toBe(0);
    expect(r.fullPull).toBe(true);
    expect(server.store.blocks.has("y1")).toBe(false);
    expect([...b.store.blocks.keys()].sort()).toEqual(["p2", "y1"]);
    // Kommt der Record vom Server (dort aus dem Y.Doc materialisiert), ist er nicht mehr abgeleitet.
    server.store.transact("Edit", (tx) => tx.put(block("y1", "w", "aus dem Y.Doc")));
    await client(b, server).syncOnce();
    expect(b.persistence.derivedKeys()).toEqual([]);
  });

  it("BSD-220: promoteDerived pusht abgeleitete Änderungen doch (Echtzeit-Text aus)", async () => {
    const server = new FakeServer();
    const a = device();
    await client(a, server).syncNow();
    a.store.transact("Edit", (tx) => tx.put(block("y2", "w", "offline")), { derived: true });
    expect((await client(a, server).syncOnce()).pushed).toBe(0);
    expect(a.persistence.promoteDerived()).toBe(1);
    expect(a.persistence.derivedKeys()).toEqual([]);
    expect((await client(a, server).syncOnce()).pushed).toBe(1);
    expect(server.store.blocks.get("y2")?.text).toBe("offline");
  });

  it("Push 1,5 s nach einer lokalen Änderung, Long-Poll holt Fremdänderungen", async () => {
    const server = new FakeServer();
    const a = device(), b = device();
    const ca = client(a, server), cb = client(b, server);
    ca.start({ intervalMs: 60_000, pushDelayMs: 20, waitTimeoutSeconds: 1 });
    cb.start({ intervalMs: 60_000, pushDelayMs: 20, waitTimeoutSeconds: 1 });
    try {
      await new Promise((r) => setTimeout(r, 50));
      createPage(a.store, "live", "Live");
      await expect.poll(() => b.store.blocks.get("live")?.text, { timeout: 3000 }).toBe("Live");
    } finally {
      ca.stop();
      cb.stop();
    }
  });

  it("falscher Token: sichtbarer Fehler, Cursor bleiben stehen", async () => {
    const server = new FakeServer();
    const a = device();
    createPage(a.store, "p1");
    const c = new SyncClient(a.store, a.persistence, { baseURL: "https://based.test", token: "falsch", fetch: server.fetch });
    await c.syncNow();
    expect(c.lastError).toContain("HTTP 401");
    expect(a.persistence.metaInt(PUSHED_KEY)).toBe(0);
  });
});

describe("WASM-Treiber (In-Memory in Node)", () => {
  it("migriert, schreibt und liest wie node:sqlite", async () => {
    const db = await openWasmDatabase();
    const d = device(db);
    createPage(d.store, "p1", "wasm");
    deleteForever(d.store, "p1");
    createPage(d.store, "p2", "bleibt");
    expect(schemaVersion(db)).toBe(3);
    const again = device(db);
    expect([...again.store.blocks.keys()]).toEqual(["p2"]);
    expect(again.persistence.tombstone(keyOf("block", "p1"))).toBeDefined();
    const server = new FakeServer();
    await client(again, server).syncOnce();
    expect(server.store.blocks.get("p2")?.text).toBe("bleibt");
  });
});
