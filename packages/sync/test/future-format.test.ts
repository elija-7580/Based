// BSD-583: Beta-Daten überstehen den späteren Formatwechsel (Protokoll v4, Ende-zu-Ende, Server). Nur prüfen und
// absichern, kein neues Format: „v5“ und „Protokoll 4“ sind hier gedachte Nachfolger.
//
// 1. Eine Datei im Format der Beta (test/fixtures/beta/) geht durch eine spätere Migration (v5), ohne dass eine Zeile
//    verloren geht oder sich ändert (Records inkl. Agent Brain – das sind normale Records –, Dateiverweise, Change-Log).
// 2. Die Beta öffnet eine Datei mit höherer Schema-Version nicht, ändert sie nicht und sagt „Update Based“.
// 3. Die Beta gegen einen Server mit neuerem Protokoll: klare Meldung, nichts gesendet, nichts verloren; ein Ordner
//    (iCloud) mit Segmenten eines neueren Builds: klare Meldung, nichts eingemischt, nichts gelöscht.
// 4. (Records mit unbekannten Feldern: apps/server/test/future-fields.test.ts, Ende-zu-Ende über den echten Server.)
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPage, MemoryPersistence, renamePage, WorkspaceStore } from "@based/core";
import {
  FolderSync, MAX_SYNC_PROTOCOL, MIGRATIONS, migrate, newerSegmentVersion, openWorkspace, PersistenceError, PULLED_KEY, PUSHED_KEY, schemaVersion,
  segmentName, SqlitePersistence, SyncClient, SyncProtocolError, type FolderTarget, type Migration, type SqlDatabase,
} from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import { FakeServer } from "./fake-server.js";

const DIR = fileURLToPath(new URL("./fixtures/beta/", import.meta.url));
const FIXTURES = readdirSync(DIR).filter((f) => f.endsWith(".sqlite")).sort();

/** Alle Tabellen, die Nutzerdaten tragen, als vergleichbarer Text (Zeile für Zeile, Bytes als hex). */
function dump(db: SqlDatabase) {
  const hex = (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("hex") : String(v));
  const table = (sql: string) => db.all(sql).map((r) => Object.values(r).map(hex).join("|"));
  return {
    records: table("SELECT kind, id, data FROM records ORDER BY kind, id"),
    changes: table("SELECT kind, id, deleted FROM changes ORDER BY kind, id"),
    quarantine: table("SELECT kind, id, data FROM quarantine ORDER BY kind, id"),
    meta: table("SELECT key, value FROM meta WHERE key NOT LIKE 'migration.%' ORDER BY key"),
  };
}

/** Eine gedachte spätere Migration (z. B. Bereich je Record für Ende-zu-Ende/Agenten): nur Spalten dazu. */
const FUTURE: Migration = {
  version: 5,
  name: "future: scope per record (test only)",
  apply(db) {
    db.exec("ALTER TABLE records ADD COLUMN scope TEXT");
  },
};

function withCopy<T>(fixture: string, body: (file: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "based-future-"));
  try {
    const file = join(tmp, "based.sqlite");
    copyFileSync(join(DIR, fixture), file);
    return body(file);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("BSD-583 (1): Beta-Datei geht durch eine spätere Migration ohne Verlust", () => {
  it("die Fixtures der Beta liegen vor (mit und ohne Property-Records)", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(2);
  });

  for (const f of FIXTURES) {
    it(`${f}: erst mit der Beta geöffnet und bearbeitet, dann v5 – jede Zeile gleich, Sicherung angelegt`, () => {
      withCopy(f, (file) => {
        // so sieht die Datei auf dem Mac eines Testers aus: mit dieser Version geöffnet und weiter benutzt
        const beta = openNodeDatabase(file);
        const { store } = openWorkspace(beta, { node: "BETATESTER" });
        createPage(store, { title: "Written during the beta" });
        const before = dump(beta);
        const betaVersion = schemaVersion(beta);
        expect(before.records.length).toBeGreaterThan(10);
        beta.close();

        const later = openNodeDatabase(file);
        migrate(later, [...MIGRATIONS, FUTURE]);
        expect(schemaVersion(later)).toBe(5);
        expect(dump(later)).toEqual(before);
        // vor der Migration wird gesichert (Datei-Kopie), und das Protokoll nennt den Weg
        expect(later.all("SELECT value FROM meta WHERE key = 'migration.log'").length).toBe(1);
        const backup = later.all("SELECT value FROM meta WHERE key = 'migration.backup'");
        expect(backup.length).toBe(1);
        expect(betaVersion).toBeGreaterThanOrEqual(3);
        later.close();
      });
    });
  }
});

describe("BSD-583 (2): die Beta öffnet eine neuere Datei nicht und lässt sie unverändert", () => {
  for (const f of FIXTURES) {
    it(`${f} auf v5: newerFormat mit „Update Based“, Inhalt und Version unverändert`, () => {
      withCopy(f, (file) => {
        const later = openNodeDatabase(file);
        openWorkspace(later, { node: "LATERBUILD" }); // Beta-Stand herstellen (inkl. Property-Records, wenn Vorgabe)
        migrate(later, [...MIGRATIONS, FUTURE]);
        const before = dump(later);
        later.close();

        const beta = openNodeDatabase(file);
        let error: unknown;
        try {
          openWorkspace(beta, { node: "BETATESTER" });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(PersistenceError);
        expect((error as PersistenceError).code).toBe("newerFormat");
        expect((error as Error).message).toMatch(/newer version of Based.*Update Based/);
        // auch „Property-Records einschalten“ darf die neuere Datei nicht anfassen
        expect(() => openWorkspace(beta, { node: "BETATESTER", propertyRecords: true })).toThrow(PersistenceError);
        expect(schemaVersion(beta)).toBe(5);
        expect(dump(beta)).toEqual(before);
        beta.close();
      });
    });
  }
});

describe("BSD-583 (3): Server mit neuerem Protokoll", () => {
  const device = () => {
    const persistence = new SqlitePersistence(openNodeDatabase());
    return { persistence, store: new WorkspaceStore({ persistence, node: "beta" }) };
  };

  it(`info meldet Protokoll ${MAX_SYNC_PROTOCOL + 1}: kein Push, kein Pull, Cursor bleiben, Status sagt „Update Based“`, async () => {
    const server = new FakeServer();
    const seen: string[] = [];
    const { store, persistence } = device();
    const statuses: string[] = [];
    const client = new SyncClient(store, persistence, {
      baseURL: "http://server", token: server.token, onStatus: (s) => statuses.push(s),
      fetch: async (input, init) => {
        const url = String(input);
        seen.push(url.replace("http://server/", "").split("?")[0]!);
        if (url.endsWith("/sync/v2/info")) return new Response(JSON.stringify({ protocol: MAX_SYNC_PROTOCOL + 1, seq: 7, oldestSeq: 0 }), { status: 200 });
        return server.fetch(input, init);
      },
    });
    const page = createPage(store, { title: "Written offline" });
    await expect(client.syncOnce()).rejects.toBeInstanceOf(SyncProtocolError);
    expect(seen).toEqual(["sync/v2/info"]);
    expect(persistence.metaInt(PUSHED_KEY)).toBe(0);
    expect(persistence.metaInt(PULLED_KEY)).toBe(0);
    await client.syncNow();
    expect(statuses.at(-1)).toMatch(/^Sync error: This server uses a newer sync protocol \(v4\)\. Update Based/);
    expect(client.lastError).toMatch(/Update Based/);
    expect(store.blocks.get(page)?.text).toBe("Written offline");
    expect(persistence.changes(0, 100).length).toBeGreaterThan(0); // wartet weiter auf den Push
  });

  it("ein späterer Server, der die Beta noch bedient (info nennt ihr Protokoll), synct wie bisher", async () => {
    const server = new FakeServer();
    const { store, persistence } = device();
    const client = new SyncClient(store, persistence, {
      baseURL: "http://server", token: server.token,
      fetch: async (input, init) => {
        if (String(input).endsWith("/sync/v2/info")) {
          const asked = Number(new Headers(init?.headers).get("x-based-protocol"));
          return new Response(JSON.stringify({ protocol: asked, seq: 0, oldestSeq: 0, newFeature: { scope: true } }), { status: 200 });
        }
        return server.fetch(input, init);
      },
    });
    const page = createPage(store, { title: "Synced" });
    expect((await client.syncOnce()).pushed).toBeGreaterThan(0);
    expect(server.store.blocks.get(page)?.text).toBe("Synced");
  });

  it("Server weist mit 426 ab (Push): Meldung nennt das Update, lokale Änderungen bleiben und gehen später hinaus", async () => {
    const server = new FakeServer();
    const { store, persistence } = device();
    let refuse = true;
    const statuses: string[] = [];
    const client = new SyncClient(store, persistence, {
      baseURL: "http://server", token: server.token, onStatus: (s) => statuses.push(s),
      fetch: async (input, init) => {
        if (refuse && String(input).includes("/sync/v2/")) {
          if (String(input).endsWith("/info")) return new Response("down", { status: 503 });
          return new Response("This workspace needs a newer Based (sync protocol 4). Update the app.", { status: 426 });
        }
        return server.fetch(input, init);
      },
    });
    const page = createPage(store, { title: "Kept" });
    await client.syncNow();
    expect(statuses.at(-1)).toMatch(/^Sync error: HTTP 426 .*Update the app/);
    expect(persistence.metaInt(PUSHED_KEY)).toBe(0);
    expect(server.store.blocks.size).toBe(0);
    // nach dem Update (hier: Server nimmt wieder an) geht alles hinaus
    refuse = false;
    await client.syncNow();
    expect(statuses.at(-1)).toMatch(/^Synced/);
    expect(server.store.blocks.get(page)?.text).toBe("Kept");
  });
});

describe("BSD-583 (3): iCloud-Ordner mit Segmenten eines neueren Builds", () => {
  function folder(): FolderTarget & { files: Map<string, Uint8Array> } {
    const files = new Map<string, Uint8Array>();
    return {
      files,
      async list(dir) {
        const out = new Set<string>();
        for (const k of files.keys()) if (k.startsWith(dir + "/")) out.add(k.slice(dir.length + 1).split("/")[0]!);
        return [...out];
      },
      async write(p, d) { files.set(p, d.slice()); },
      async read(p) { const d = files.get(p); if (!d) throw new Error("missing"); return d; },
      async remove(p) { files.delete(p); },
    };
  }
  const enc = new TextEncoder();

  it("Segment v2: nicht eingemischt, als „newer“ gemeldet, Log sagt „Update Based“; spätere Segmente warten, nichts wird gelöscht", async () => {
    const f = folder();
    const logs: string[] = [];
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "beta" });
    const sync = new FolderSync({ store, target: f, device: "betaMac", enabled: true, log: (m) => logs.push(m) });
    const mine = createPage(store, { title: "Mine" });
    await sync.round();

    // ein späteres Gerät schreibt Segment 1 im Format v2 (z. B. verschlüsselt) und Segment 2 wieder lesbar
    const future = [
      JSON.stringify({ format: "based-folder-sync", v: 2, device: "laterMac", seq: 1, count: 1 }),
      JSON.stringify({ op: "sealed", box: "AAAA" }),
      JSON.stringify({ end: true, count: 1 }),
    ].join("\n") + "\n";
    f.files.set(`devices/laterMac/${segmentName(1)}`, enc.encode(future));
    const del = [
      JSON.stringify({ format: "based-folder-sync", v: 1, device: "laterMac", seq: 2, count: 1 }),
      JSON.stringify({ op: "del", key: `block:${mine}`, stamp: { millis: Date.now() + 1000, counter: 0, node: "later" } }),
      JSON.stringify({ end: true, count: 1 }),
    ].join("\n") + "\n";
    f.files.set(`devices/laterMac/${segmentName(2)}`, enc.encode(del));

    expect(newerSegmentVersion(enc.encode(future))).toBe(2);
    expect(newerSegmentVersion(enc.encode(del))).toBeUndefined();
    const r = await sync.round();
    expect(r.newer).toEqual([`laterMac/${segmentName(1)}`]);
    expect(r.received).toBe(0);
    expect(logs.some((l) => /newer version of Based \(folder format v2\)\. Update Based/.test(l))).toBe(true);
    // Reihenfolge bleibt: Segment 2 (Löschung) wartet hinter dem unlesbaren Segment 1
    expect(store.blocks.has(mine)).toBe(true);
    expect(sync.state().seen.laterMac ?? 0).toBe(0);
    renamePage(store, mine, "Still mine");
    expect((await sync.round()).pushed).toBeGreaterThan(0);
    expect(f.files.has(`devices/laterMac/${segmentName(1)}`)).toBe(true);
  });

  it("halbe Datei im aktuellen Format bleibt „kommt noch“, nicht „newer“", async () => {
    const f = folder();
    const store = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "beta" });
    const sync = new FolderSync({ store, target: f, device: "betaMac", enabled: true });
    f.files.set(`devices/other/${segmentName(1)}`, enc.encode(JSON.stringify({ format: "based-folder-sync", v: 1, device: "other", seq: 1, count: 3 }) + "\n"));
    const r = await sync.round();
    expect(r.newer).toEqual([]);
    expect(r.waiting).toBe(1);
  });
});
