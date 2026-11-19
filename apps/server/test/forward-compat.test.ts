// Vorwärts-Verträglichkeit der Beta (Elija, 18.11.): Was eine spätere Version dazuschreibt – ein Ende-zu-Ende-Umschlag,
// der Bereich und dessen Stufe je Record (ADR 0017 Stufe C) –, darf eine ältere App nicht zerstören. Geprüft wird das,
// was sich nach der Beta nicht mehr in die verteilte App nachrüsten lässt:
//   1. Felder, die diese Version nicht kennt, überstehen Sync, Ändern, Speichern und Neustart unverändert.
//   2. Ein Server mit neuerem Protokoll lehnt ab, ohne dass etwas verloren geht, und die App sagt „Update Based“.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPage, renamePage, type Block, type WireRecord } from "@based/core";
import { openWorkspace, SyncClient, UPDATE_TO_SYNC } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { auth, post, protocolHeader, startApp, TOKEN } from "./helpers.js";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

/** Was eine spätere Version an einen Block hängen könnte (Namen aus ADR 0017; verschachtelt, damit nichts flach kopiert wird). */
const FUTURE = { scope: "area-7", level: "private", envelope: { v: 4, alg: "xchacha20", nonce: "AAAA", parts: [1, 2, 3] } };
const futureOf = (b: Block | undefined) => {
  const x = (b ?? {}) as unknown as Record<string, unknown>;
  return { scope: x.scope, level: x.level, envelope: x.envelope };
};

describe("Felder aus einer späteren Version bleiben erhalten", () => {
  it("vom neueren Gerät über den Server zum älteren, dort geändert, gespeichert, neu gestartet und zurück", async () => {
    const app = await startApp();
    cleanup.push(() => app.close());
    const dir = mkdtempSync(join(tmpdir(), "based-fc-"));

    // Gerät „neu“ schreibt eine Seite mit Feldern, die es heute nicht gibt (roh in den Push, wie eine spätere App).
    const seed = openWorkspace(openNodeDatabase(), { node: "seed" });
    const page = createPage(seed.store, { title: "Plan" });
    const record: WireRecord = { kind: "block", data: { ...structuredClone(seed.store.blocks.get(page)!), ...FUTURE } as Block };
    const pushed = await post(`${app.url}/sync/v2/push`, { records: [record], deletions: [] });
    expect(pushed.status).toBe(200);
    // Der Server hat sie behalten (er ist selbst „ältere Version“).
    expect(futureOf(app.sync.store.blocks.get(page))).toEqual(FUTURE);

    // Gerät „alt“ holt sie, ändert den Titel, speichert auf die Platte.
    const path = join(dir, "old.sqlite");
    const old = openWorkspace(openNodeDatabase(path), { node: "old" });
    const client = new SyncClient(old.store, old.persistence, { baseURL: app.url, token: TOKEN });
    await client.syncOnce();
    expect(futureOf(old.store.blocks.get(page))).toEqual(FUTURE);
    renamePage(old.store, page, "Plan, edited on the old device");
    expect(futureOf(old.store.blocks.get(page))).toEqual(FUTURE);
    await client.syncOnce();

    // Neustart des alten Geräts: aus der Datei gelesen, Felder noch da.
    const reopened = openWorkspace(openNodeDatabase(path), { node: "old" });
    expect(reopened.store.blocks.get(page)!.text).toBe("Plan, edited on the old device");
    expect(futureOf(reopened.store.blocks.get(page))).toEqual(FUTURE);

    // Zurück beim Server und bei einem dritten Gerät: Titel neu, Felder unverändert.
    expect(app.sync.store.blocks.get(page)!.text).toBe("Plan, edited on the old device");
    expect(futureOf(app.sync.store.blocks.get(page))).toEqual(FUTURE);
    const third = openWorkspace(openNodeDatabase(), { node: "third" });
    await new SyncClient(third.store, third.persistence, { baseURL: app.url, token: TOKEN }).syncOnce();
    expect(futureOf(third.store.blocks.get(page))).toEqual(FUTURE);
  });
});

describe("Server mit neuerem Protokoll", () => {
  it("lehnt ein älteres Gerät mit 426 ab; das Gerät behält seine Änderungen und sagt, was zu tun ist", async () => {
    const app = await startApp();
    cleanup.push(() => app.close());
    const d = openWorkspace(openNodeDatabase(), { node: "old" });
    const page = createPage(d.store, { title: "Written offline" });
    // Ein späterer Server: jede Sync-Anfrage mit dem heutigen Protokoll bekommt 426 (so antwortet der Server schon
    // heute einem Gerät mit zu altem Protokoll, apps/server/src/sync.ts).
    const statuses: string[] = [];
    const newer: typeof fetch = async () => new Response(JSON.stringify({ error: "This workspace needs a newer Based (sync protocol 4). Update the app." }), { status: 426 });
    const blocked = new SyncClient(d.store, d.persistence, { baseURL: app.url, token: TOKEN, fetch: newer, onStatus: (s) => statuses.push(s) });
    await blocked.syncNow();
    expect(statuses.at(-1)).toBe(UPDATE_TO_SYNC);
    expect(blocked.lastError).toBe(UPDATE_TO_SYNC);
    // Nichts verloren, nichts halb übertragen.
    expect(d.store.blocks.get(page)!.text).toBe("Written offline");
    expect(app.sync.store.blocks.has(page)).toBe(false);
    // Nach dem „Update“ (hier: der echte Server) geht die wartende Änderung hinaus.
    await new SyncClient(d.store, d.persistence, { baseURL: app.url, token: TOKEN }).syncOnce();
    expect(app.sync.store.blocks.get(page)!.text).toBe("Written offline");
  });

  it("der heutige Server antwortet einem zu alten Protokoll mit 426 und einem Satz für den Nutzer", async () => {
    const app = await startApp();
    cleanup.push(() => app.close());
    const mine = Number(protocolHeader()["X-Based-Protocol"] ?? 2);
    const r = await fetch(`${app.url}/sync/v2/pull?after=0`, { headers: { ...auth, "X-Based-Protocol": String(mine - 1) } });
    // Protokoll 1 gibt es nicht als eigenes Gerät – wichtig ist nur: kleiner als der Server → 426 mit Erklärung.
    if (mine > 2) {
      expect(r.status).toBe(426);
      expect(((await r.json()) as { error: string }).error).toContain("Update the app");
    } else expect([200, 426]).toContain(r.status);
  });
});
