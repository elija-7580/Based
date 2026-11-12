// Kompatibilität (a): der TS-Sync-Client (packages/sync `SyncClient`) gegen den TS-Server über echtes HTTP.
// Gleiche Szenarien wie packages/sync/test/sync.test.ts (dort gegen den In-Prozess-FakeServer).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify, encodeRecord, keyOf, parseRecord, recordKey, type WireRecord, WorkspaceStore } from "@based/core";
import { openWorkspace, PULLED_KEY, PUSHED_KEY, SqlitePersistence, SyncClient, type SqlDatabase } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { startApp, TOKEN } from "./helpers.js";

// Diese Datei prüft das alte Format (Properties im Datenbank-Record, Protokoll 2) – auch wenn die Suite sonst mit
// BASED_PROPERTY_RECORDS=1 läuft (BSD-30).
WorkspaceStore.propertyRecordsByDefault = false;

const corpus = readFileSync(fileURLToPath(new URL("../../../fixtures/records/corpus.jsonl", import.meta.url)), "utf8")
  .split("\n")
  .filter((l) => l.length > 0 && !l.includes('"id":"workspace-2"'));

const block = (id: string, text = id): WireRecord => ({
  kind: "block",
  data: { id, type: "page", parent: "w", sk: "a0", text, createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "x" } },
});

type Device = { store: WorkspaceStore; persistence: SqlitePersistence };
const device = (db: SqlDatabase = openNodeDatabase()): Device => openWorkspace(db);
const createPage = (s: WorkspaceStore, id: string, text = id) => s.transact("New page", (tx) => tx.put(block(id, text)));
const deleteForever = (s: WorkspaceStore, id: string) => s.transact("Delete forever", (tx) => tx.remove(keyOf("block", id)));
const snapshot = (s: WorkspaceStore) =>
  s.allRecords().filter((r) => (r.data.stamp as { millis: number } | undefined)?.millis).map((r) => canonicalStringify(r)).sort();

let apps: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function server() {
  const app = await startApp();
  apps.push(app);
  const client = (d: Device, pageSize = 500, token = TOKEN) => new SyncClient(d.store, d.persistence, { baseURL: app.url, token, pageSize });
  return { app, client };
}

describe("SyncClient ↔ TS-Server", () => {
  it("echter Workspace (Swift-Korpus) wandert byte-gleich in einen zweiten Client, Rückweg ohne Änderung", async () => {
    const { app, client } = await server();
    const records = corpus.map((l) => parseRecord(JSON.parse(l)));
    const file = openNodeDatabase();
    new SqlitePersistence(file).write(records, [], new Map(), true);
    const a = device(file);
    await client(a, 7).syncOnce();

    const b = device();
    const r = await client(b, 5).syncOnce();
    expect(r.received).toBe(records.length);
    const byKey = new Map(b.store.allRecords().map((x) => [recordKey(x), x]));
    for (const line of corpus) {
      const original = parseRecord(JSON.parse(line));
      expect(encodeRecord(byKey.get(recordKey(original))!), recordKey(original)).toBe(line);
    }
    const before = app.sync.seq;
    expect((await client(b).syncOnce()).pushed).toBe(0);
    expect(app.sync.seq).toBe(before);
  });

  it("offline bearbeiten, wieder online; Löschungen mit Stempel kommen an", async () => {
    const { app, client } = await server();
    const a = device(), b = device();
    createPage(a.store, "p1", "Hallo");
    await client(a).syncNow();
    await client(b).syncNow();
    expect(b.store.blocks.get("p1")?.text).toBe("Hallo");

    const offline = new SyncClient(a.store, a.persistence, { baseURL: "http://127.0.0.1:1", token: TOKEN });
    a.store.setText("p1", "Offline geändert");
    createPage(a.store, "p2", "Neu offline");
    await offline.syncNow();
    expect(offline.lastError).toBeDefined();

    await client(a).syncNow();
    await client(b).syncNow();
    expect(b.store.blocks.get("p1")?.text).toBe("Offline geändert");
    expect(snapshot(b.store)).toEqual(snapshot(a.store));

    deleteForever(a.store, "p2");
    await client(a).syncNow();
    await client(b).syncNow();
    expect(b.store.blocks.has("p2")).toBe(false);
    expect(b.persistence.tombstone(keyOf("block", "p2"))).toBeDefined();
    expect(app.sync.persistence.tombstone(keyOf("block", "p2"))).toEqual(a.persistence.tombstone(keyOf("block", "p2")));
  });

  it("Tombstones: neuere Löschung gewinnt, neuere Bearbeitung gewinnt gegen ältere Löschung", async () => {
    const { app, client } = await server();
    const a = device(), b = device();
    createPage(a.store, "p1");
    createPage(a.store, "p2");
    await client(a).syncNow();
    await client(b).syncNow();
    b.store.clock.wallClock = () => Date.now() + 1000;
    a.store.clock.wallClock = () => Date.now() + 2000;
    b.store.setText("p1", "B früher");
    deleteForever(a.store, "p1");
    a.store.clock.wallClock = () => Date.now() + 3000;
    b.store.clock.wallClock = () => Date.now() + 4000;
    deleteForever(a.store, "p2");
    b.store.setText("p2", "B später");
    await client(a).syncNow();
    await client(b).syncNow();
    await client(a).syncNow();
    expect(a.store.blocks.has("p1")).toBe(false);
    expect(b.store.blocks.has("p1")).toBe(false);
    expect(a.store.blocks.get("p2")?.text).toBe("B später");
    expect(b.store.blocks.get("p2")?.text).toBe("B später");
    expect(app.sync.store.blocks.has("p1")).toBe(false);
  });

  it("newer in der Push-Antwort", async () => {
    const { client } = await server();
    const a = device(), b = device();
    createPage(a.store, "p1", "alt");
    await client(a).syncNow();
    await client(b).syncNow();
    b.store.clock.wallClock = () => Date.now() + 10_000;
    b.store.setText("p1", "neu von B");
    await client(b).syncNow();
    a.store.setText("p1", "älter von A");
    expect((await client(a).syncOnce()).pushed).toBe(1);
    expect(a.store.blocks.get("p1")?.text).toBe("neu von B");
  });

  it("Seiten mit kleiner Seitengröße, Cursor stimmen", async () => {
    const { app, client } = await server();
    const a = device(), b = device();
    a.store.transact("viele", (tx) => {
      for (let i = 0; i < 23; i++) tx.put(block(`p${i}`));
    });
    await client(a, 4).syncOnce();
    expect(a.persistence.metaInt(PUSHED_KEY)).toBe(a.persistence.maxSeq());
    expect((await client(b, 3).syncOnce()).received).toBe(23);
    expect(b.persistence.metaInt(PULLED_KEY)).toBe(app.sync.seq);
  });

  it("Tombstone-GC: Gerät hinter oldestSeq holt alles neu und löscht Verschwundenes", async () => {
    const { app, client } = await server();
    const a = device(), b = device();
    createPage(a.store, "p1");
    createPage(a.store, "p2");
    await client(a).syncNow();
    await client(b).syncNow();
    deleteForever(a.store, "p2");
    createPage(a.store, "p3");
    await client(a).syncNow();
    expect(app.sync.compactTombstones(90, Date.now() + 91 * 86_400_000)).toBe(1);
    createPage(b.store, "b1");
    const r = await client(b).syncOnce();
    expect(r.fullPull).toBe(true);
    expect([...b.store.blocks.keys()].sort()).toEqual(["b1", "p1", "p3"]);
    expect(app.sync.store.blocks.has("b1")).toBe(true);
  });

  it("Live: Push nach lokaler Änderung, Long-Poll holt sie beim anderen Gerät", async () => {
    const { client } = await server();
    const a = device(), b = device();
    const ca = client(a), cb = client(b);
    ca.start({ intervalMs: 60_000, pushDelayMs: 20, waitTimeoutSeconds: 5 });
    cb.start({ intervalMs: 60_000, pushDelayMs: 20, waitTimeoutSeconds: 5 });
    try {
      await new Promise((r) => setTimeout(r, 100));
      createPage(a.store, "live", "Live");
      await expect.poll(() => b.store.blocks.get("live")?.text, { timeout: 3000 }).toBe("Live");
    } finally {
      ca.stop();
      cb.stop();
    }
  });

  it("falscher Token: 401 sichtbar, Cursor bleiben stehen", async () => {
    const { client } = await server();
    const a = device();
    createPage(a.store, "p1");
    const c = client(a, 500, "falsch");
    await c.syncNow();
    expect(c.lastError).toContain("HTTP 401");
    expect(a.persistence.metaInt(PUSHED_KEY)).toBe(0);
  });
});
