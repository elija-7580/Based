// BSD-583: Beta-Daten überstehen den späteren Formatwechsel – Ergänzung zu forward-compat.test.ts (dort: neuere Datei
// wird nicht geöffnet, 426, iCloud-Segmente). Nur prüfen und absichern, kein neues Format: „v5“ und „Protokoll 4“ sind
// gedachte Nachfolger.
// 1. Eine Datei im Format der Beta (test/fixtures/beta/, mit und ohne Property-Records), mit der Beta weiter benutzt,
//    geht durch eine spätere Migration (v5), ohne dass eine Zeile verloren geht oder sich ändert (Records inkl. Agent
//    Brain – das sind normale Records –, Dateiverweise, Change-Log, Quarantäne, Meta); vorher wird gesichert.
// 3. Ein Server, der in `info` ein neueres Protokoll nennt, bekommt nichts (auch ohne 426); einer, der die Beta noch
//    bedient, synct wie bisher.
// 4. Unbekannte Felder an Datenbank, Ansicht, Zeile und Property-Record: apps/server/test/future-fields.test.ts.
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPage, WorkspaceStore } from "@based/core";
import {
  MAX_SYNC_PROTOCOL, MIGRATIONS, migrate, openWorkspace, PULLED_KEY, PUSHED_KEY, schemaVersion, SqlitePersistence, SyncClient,
  SyncProtocolError, UPDATE_TO_SYNC, type Migration, type SqlDatabase,
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

describe("BSD-583 (3): Server mit neuerem Protokoll", () => {
  const device = () => {
    const persistence = new SqlitePersistence(openNodeDatabase());
    return { persistence, store: new WorkspaceStore({ persistence, node: "beta" }) };
  };

  it(`info meldet Protokoll ${MAX_SYNC_PROTOCOL + 1}: kein Push, kein Pull, Cursor bleiben, Status wie bei 426`, async () => {
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
    expect(statuses.at(-1)).toBe(UPDATE_TO_SYNC);
    expect(client.lastError).toBe(UPDATE_TO_SYNC);
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
});
