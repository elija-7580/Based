// BSD-179: ein frischer based-server darf beim ersten Sync den Workspace eines Geräts (Name, Favoriten,
// Teamspaces, Home-Seite) nicht überschreiben. Der Swift-Server tut das (er legt beim Start einen eigenen
// Workspace-Record „My Workspace“ mit Stempel = Startzeit, node „server“ an; Last-Writer-Wins). Der TS-Server legt
// keinen an; übernimmt er aber eine Datei, die der Swift-Server angelegt hat, steht dessen Record schon darin.
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify, createTeamspace, setFavorite, WORKSPACE_ID, type WireRecord, type WorkspaceStore } from "@based/core";
import { openWorkspace, SqlitePersistence, SyncClient, type SqlDatabase } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { startApp, TOKEN } from "./helpers.js";

type Device = { store: WorkspaceStore; persistence: SqlitePersistence };
const device = (db: SqlDatabase = openNodeDatabase()): Device => openWorkspace(db);

let apps: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

/** Gerät mit benanntem Workspace, einer Favoriten-Seite, einem Teamspace und einer Home-Seite. */
function namedDevice(): Device {
  const d = device();
  d.store.transact("New page", (tx) =>
    tx.put({ kind: "block", data: { id: "p1", type: "page", parent: "w", sk: "a0", text: "Roadmap", createdAt: 0, updatedAt: 0, stamp: { millis: 0, counter: 0, node: "" } } }),
  );
  d.store.transact("Rename workspace", (tx) => tx.put({ kind: "workspace", data: { ...d.store.workspace, name: "Studio", homePageID: "p1" } }));
  setFavorite(d.store, ["p1"], true);
  createTeamspace(d.store, "Design");
  return d;
}

const content = (s: WorkspaceStore) => {
  const { stamp: _stamp, ...rest } = s.workspace;
  return canonicalStringify(rest);
};

describe("BSD-179: frischer Server und der Workspace-Record", () => {
  it("frischer TS-Server: Workspace des Geräts bleibt, Server und zweites Gerät bekommen ihn", async () => {
    const app = await startApp();
    apps.push(app);
    const client = (d: Device) => new SyncClient(d.store, d.persistence, { baseURL: app.url, token: TOKEN });
    // Ein frischer Server hat nichts im Change-Log, auch keinen Workspace-Record.
    expect(app.sync.seq).toBe(0);
    expect(app.sync.pull(0).records).toEqual([]);

    const a = namedDevice();
    const before = content(a.store);
    expect(a.store.workspace.name).toBe("Studio");
    expect(a.store.workspace.favorites).toEqual(["p1"]);
    expect(a.store.workspace.teamspaces?.map((t) => t.name)).toEqual(["Design"]);

    await client(a).syncOnce();
    await client(a).syncOnce();
    expect(content(a.store)).toBe(before);
    expect(content(app.sync.store)).toBe(before);

    const b = device();
    await client(b).syncOnce();
    expect(content(b.store)).toBe(before);
    // B hat nichts Eigenes: es pusht seinen Standard-Workspace nicht zurück.
    const seq = app.sync.seq;
    await client(b).syncOnce();
    expect(app.sync.seq).toBe(seq);
    await client(a).syncOnce();
    expect(content(a.store)).toBe(before);
  });

  it("ein neues, leeres Gerät überschreibt den Workspace auf dem Server nicht", async () => {
    const app = await startApp();
    apps.push(app);
    const client = (d: Device) => new SyncClient(d.store, d.persistence, { baseURL: app.url, token: TOKEN });
    const a = namedDevice();
    const before = content(a.store);
    await client(a).syncOnce();
    // B legt vor dem ersten Sync eine Seite an (Erststart mit Willkommensseite), fasst den Workspace aber nicht an.
    const b = device();
    b.store.transact("New page", (tx) =>
      tx.put({ kind: "block", data: { id: "welcome", type: "page", parent: "w", sk: "a1", text: "Welcome", createdAt: 0, updatedAt: 0, stamp: { millis: 0, counter: 0, node: "" } } }),
    );
    await client(b).syncOnce();
    await client(a).syncOnce();
    expect(content(a.store)).toBe(before);
    expect(content(b.store)).toBe(before);
    expect(a.store.blocks.has("welcome")).toBe(true);
  });

  it("Datei vom Swift-Server (unberührter Standard-Workspace mit Server-Stempel): der ältere Record des Geräts gewinnt trotzdem", async () => {
    // So sieht die Datei aus, nachdem der Swift-based-server sie angelegt hat: Workspace-Record „My Workspace“,
    // Stempel = Startzeit, node „server“, im Change-Log als lokale Änderung.
    const a = namedDevice();
    const before = content(a.store);
    const file = openNodeDatabase();
    const later = a.store.workspace.stamp.millis + 60_000;
    const serverDefault: WireRecord = {
      kind: "workspace",
      data: { id: WORKSPACE_ID, name: "My Workspace", favorites: [], createdAt: 0, updatedAt: 0, stamp: { millis: later, counter: 0, node: "server" } },
    };
    new SqlitePersistence(file).write([serverDefault], [], new Map(), true);
    const app = await startApp({ db: file, nowMillis: () => later + 1000 });
    apps.push(app);
    app.sync.store.clock.wallClock = () => later + 1000;
    const client = (d: Device) => new SyncClient(d.store, d.persistence, { baseURL: app.url, token: TOKEN });

    await client(a).syncOnce();
    expect(content(a.store)).toBe(before);
    expect(content(app.sync.store)).toBe(before);

    // Ein Gerät, das den Server-Standard schon hatte, bekommt den echten Workspace (neuerer Stempel).
    const b = device();
    b.store.applyRemote([serverDefault]);
    await client(b).syncOnce();
    expect(content(b.store)).toBe(before);
    await client(a).syncOnce();
    expect(content(a.store)).toBe(before);
    expect(a.store.workspace.stamp).toEqual(b.store.workspace.stamp);
  });

  it("ein vom Nutzer geänderter Workspace auf dem Server gewinnt weiter per Last-Writer-Wins", async () => {
    const a = namedDevice();
    const file = openNodeDatabase();
    const later = a.store.workspace.stamp.millis + 60_000;
    // Neuerer Stand eines anderen Geräts (nicht der Server-Standard): bleibt.
    const other: WireRecord = {
      kind: "workspace",
      data: { id: WORKSPACE_ID, name: "My Workspace", favorites: [], createdAt: 0, updatedAt: 0, stamp: { millis: later, counter: 0, node: "PHONE" } },
    };
    new SqlitePersistence(file).write([other], [], new Map(), false);
    const app = await startApp({ db: file });
    apps.push(app);
    await new SyncClient(a.store, a.persistence, { baseURL: app.url, token: TOKEN }).syncOnce();
    expect(a.store.workspace.name).toBe("My Workspace");
    expect(a.store.workspace.stamp.node).toBe("PHONE");
  });
});
