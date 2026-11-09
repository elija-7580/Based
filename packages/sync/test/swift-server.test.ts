// BSD-152 Akzeptanz gegen den echten Swift-based-server. Läuft nur mit gebautem Server:
//   (cd Swift/BasedBrain && swift build --product based-server)
//   BASED_SERVER_BIN=$PWD/Swift/BasedBrain/.build/debug/based-server pnpm --filter @based/sync test
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalStringify, encodeRecord, keyOf, parseRecord, recordKey, type WireRecord, type WorkspaceStore } from "@based/core";
import { openWorkspace, SqlitePersistence, SyncClient, type SqlDatabase } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";

const bin = process.env.BASED_SERVER_BIN;
const corpus = readFileSync(fileURLToPath(new URL("../../../fixtures/records/corpus.jsonl", import.meta.url)), "utf8")
  .split("\n")
  .filter((l) => l.length > 0 && !l.includes('"id":"workspace-2"'));

describe.skipIf(!bin)("gegen den Swift-based-server", () => {
  const token = "ts-sync-test-token";
  const port = 18_000 + Math.floor(Math.random() * 1000);
  const dir = mkdtempSync(join(tmpdir(), "based-swift-"));
  const dbPath = join(dir, "server.sqlite");
  let proc: ChildProcess;
  const baseURL = `http://127.0.0.1:${port}`;

  beforeAll(async () => {
    proc = spawn(bin!, ["--db", dbPath, "--port", String(port), "--token", token, "--no-scheduler", "--no-acp"], {
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, BASED_LOG_LEVEL: "warning" },
    });
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${baseURL}/sync/v2/info`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) return;
      } catch {
        // startet noch
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("based-server did not start");
  }, 20_000);

  afterAll(() => {
    proc?.kill();
  });

  const device = (db: SqlDatabase = openNodeDatabase()) => openWorkspace(db);
  const client = (d: { store: WorkspaceStore; persistence: SqlitePersistence }, pageSize = 500) =>
    new SyncClient(d.store, d.persistence, { baseURL, token, pageSize });
  const page = (id: string, text: string): WireRecord => ({
    kind: "block",
    data: { id, type: "page", parent: "w", sk: "a0", text, createdAt: 0, updatedAt: 0, stamp: { millis: 1, counter: 0, node: "x" } },
  });

  let a: ReturnType<typeof device>;
  let b: ReturnType<typeof device>;

  it("echter Workspace: TS → Swift-Server → TS byte-gleich, Rückweg ohne Änderung", async () => {
    const swiftFile = openNodeDatabase();
    new SqlitePersistence(swiftFile).write(corpus.map((l) => parseRecord(JSON.parse(l))), [], new Map(), true);
    a = device(swiftFile);
    await client(a, 9).syncOnce();

    b = device();
    const r = await client(b, 4).syncOnce();
    // Der Server legt beim Start eigene Records an (Agent Brain usw.); die kommen zusätzlich mit.
    expect(r.received).toBeGreaterThanOrEqual(corpus.length);
    const byKey = new Map(b.store.allRecords().map((x) => [recordKey(x), x]));
    for (const line of corpus) {
      const original = parseRecord(JSON.parse(line));
      // Befund (Backlog): ein frischer based-server legt beim Start einen eigenen Workspace-Record mit aktuellem
      // Stempel an; der gewinnt per Last-Writer-Wins gegen den älteren des Geräts (Name, Favoriten, Teamspaces).
      if (original.kind === "workspace") {
        expect(byKey.get("workspace:workspace")?.data.stamp).toMatchObject({ node: "server" });
        continue;
      }
      expect(encodeRecord(byKey.get(recordKey(original))!), recordKey(original)).toBe(line);
    }
    const info = async () => ((await (await fetch(`${baseURL}/sync/v2/info`, { headers: { Authorization: `Bearer ${token}` } })).json()) as { seq: number }).seq;
    const before = await info();
    const back = await client(b).syncOnce();
    expect(back.pushed).toBe(0);
    expect(await info()).toBe(before);
  });

  it("offline bearbeiten, wieder online: der andere Client sieht es; Löschungen mit Stempel", async () => {
    const cb = new SyncClient(b.store, b.persistence, {
      baseURL,
      token,
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    b.store.transact("New page", (tx) => tx.put(page("ts-offline", "Offline aus TS")));
    const first = [...b.store.blocks.values()].find((x) => x.type === "page" && x.parent === "w")!;
    b.store.setText(first.id, "Umbenannt offline");
    await cb.syncNow();
    expect(cb.lastError).toBe("offline");

    await client(b).syncOnce();
    await client(a).syncOnce();
    expect(a.store.blocks.get("ts-offline")?.text).toBe("Offline aus TS");
    expect(a.store.blocks.get(first.id)?.text).toBe("Umbenannt offline");

    a.store.transact("Delete forever", (tx) => tx.remove(keyOf("block", "ts-offline")));
    await client(a).syncOnce();
    await client(b).syncOnce();
    expect(b.store.blocks.has("ts-offline")).toBe(false);
    expect(b.persistence.tombstone(keyOf("block", "ts-offline"))).toBeDefined();
  });

  it("die Datei des Swift-Servers öffnet der TS-Speicher mit gleichem Inhalt", async () => {
    // Gleiches Dateiformat: die vom Swift-Server geschriebene SQLite lesen (WAL wird beim Öffnen gelesen).
    const serverView = new SqlitePersistence(openNodeDatabase(dbPath));
    const fromFile = serverView.loadAll().filter((r) => r.kind !== "workspace" || r.data.id === "workspace");
    const canon = (rs: WireRecord[]) => rs.map((r) => canonicalStringify(r)).sort();
    expect(serverView.undecodable).toEqual([]);
    expect(canon(fromFile)).toEqual(canon(b.store.allRecords()));
  });
});
