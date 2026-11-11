// BSD-282 (Elija, 11.11.): Wer eine Seite nur bearbeiten darf, legt Seiten in den Papierkorb, löscht sie aber nicht
// endgültig. Inhaltsblöcke bleiben löschbar. Endgültig löschen dürfen der Besitzer und „Full access“.
import { deleteForever, keyOf, type Block } from "@based/core";
import { SyncClient, openWorkspace } from "@based/sync";
import { afterEach, describe, expect, it } from "vitest";
import { post, startApp } from "./helpers.js";

let apps: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const a of apps) await a.close();
  apps = [];
});

async function setup() {
  const app = await startApp();
  apps.push(app);
  const shared = app.pages.create({ title: "Team Wiki", markdown: "Welcome to the wiki" });
  const sub = app.pages.create({ title: "Onboarding", parent: shared, markdown: "First day" });
  const store = app.sync.store;
  const edit = { Authorization: `Bearer ${app.share.createLink("access", shared, "edit", { kind: "owner" }).secret!}` };
  const push = (records: Block[], deletions: string[]) =>
    post(`${app.url}/sync/v2/push`, { records: records.map((data) => ({ kind: "block", data })), deletions: deletions.map((id) => ({ kind: "block", id })) }, edit);
  const later = (b: Block, change: Partial<Block>): Block => ({ ...structuredClone(b), ...change, stamp: { ...b.stamp!, millis: b.stamp!.millis + 1000, node: "guest" } });
  return { app, store, shared, sub, edit, push, later };
}

const ids = (list: unknown) => (list as { id: string }[]).map((d) => d.id);

describe("BSD-282: Gäste mit Bearbeiten-Rolle löschen Seiten nicht endgültig", () => {
  it("Seite samt Inhalt endgültig löschen wird ganz abgelehnt; die Seite kommt als Server-Kopie zurück", async () => {
    const { store, sub, push } = await setup();
    const para = store.children("b:" + sub)[0]!;
    const r = await push([], [sub, para]);
    expect(r.status).toBe(200);
    expect(store.blocks.has(sub)).toBe(true);
    expect(store.blocks.has(para)).toBe(true);
    expect(ids(r.body!.rejected).sort()).toEqual([sub, para].sort());
    expect((r.body!.newer as { data: { id: string } }[]).map((n) => n.data.id)).toEqual(expect.arrayContaining([sub, para]));
  });

  it("auch die geteilte Seite selbst und eine Seite, die schon im Papierkorb liegt", async () => {
    const { store, shared, sub, push, later } = await setup();
    expect(ids((await push([], [shared])).body!.rejected)).toEqual([shared]);
    expect(store.blocks.has(shared)).toBe(true);
    // in den Papierkorb legen geht
    await push([later(store.blocks.get(sub)!, { trashedAt: 700_000_000 })], []);
    expect(store.blocks.get(sub)?.trashedAt).toBe(700_000_000);
    // von dort endgültig löschen nicht
    expect(ids((await push([], [sub])).body!.rejected)).toEqual([sub]);
    expect(store.blocks.has(sub)).toBe(true);
  });

  it("Inhaltsblöcke bleiben löschbar", async () => {
    const { store, sub, push } = await setup();
    const para = store.children("b:" + sub)[0]!;
    const r = await push([], [para]);
    expect(r.body!.rejected ?? []).toEqual([]);
    expect(store.blocks.has(para)).toBe(false);
    expect(store.blocks.has(sub)).toBe(true);
  });

  it("ein Block, unter dem noch eine Seite hängt, wird nicht gelöscht; zieht derselbe Push die Seite heraus, schon", async () => {
    const { app, store, shared, push, later } = await setup();
    const para = store.children("b:" + shared).find((id) => store.blocks.get(id)!.type !== "page")!;
    const nested = app.pages.create({ title: "Nested", parent: shared });
    store.transact("Test", (tx) => tx.update(nested, (b) => { b.parent = "b:" + para; }));
    const r1 = await push([], [para]);
    expect(ids(r1.body!.rejected)).toEqual([para]);
    expect(store.blocks.has(para)).toBe(true);
    // wie der Client (BSD-99): Seite auf die umgebende Seite ziehen und in den Papierkorb legen, dann den Block löschen
    const r2 = await push([later(store.blocks.get(nested)!, { parent: "b:" + shared, trashedAt: 700_000_000 })], [para]);
    expect(r2.body!.rejected ?? []).toEqual([]);
    expect(store.blocks.has(para)).toBe(false);
    expect(store.blocks.get(nested)?.parent).toBe("b:" + shared);
  });

  it("Datenbank: Zeilen und die Datenbank selbst bleiben, eine einzelne Ansicht ist löschbar", async () => {
    const { app, store, shared, edit } = await setup();
    const { dbops } = await import("@based/core");
    const made = dbops.createDatabase(store, { parent: "b:" + shared, title: "Tasks" });
    const row = dbops.addRow(store, made.databaseID)!;
    const view = [...store.views.values()].find((v) => v.databaseID === made.databaseID)!;
    const extra = dbops.addView(store, view.blockID, "board")!;
    const del = (deletions: { kind: string; id: string }[]) => post(`${app.url}/sync/v2/push`, { records: [], deletions }, edit);
    // Datenbank samt Zeile und Ansicht endgültig löschen: alles abgelehnt
    const r = await del([{ kind: "block", id: row }, { kind: "database", id: made.databaseID }, { kind: "view", id: extra }]);
    expect(store.blocks.has(row)).toBe(true);
    expect(store.databases.has(made.databaseID)).toBe(true);
    expect(store.views.has(extra)).toBe(true);
    expect((r.body!.rejected as { kind: string }[]).map((d) => d.kind).sort()).toEqual(["block", "database", "view"]);
    // eine Ansicht allein ist Inhalt
    expect((await del([{ kind: "view", id: extra }])).body!.rejected ?? []).toEqual([]);
    expect(store.views.has(extra)).toBe(false);
  });

  it("„Full access“ und der Besitzer dürfen endgültig löschen", async () => {
    const { app, store, shared, sub } = await setup();
    const inv = app.share.createLink("invite", shared, "full", { kind: "owner" });
    const { token } = app.share.acceptInvite(inv.secret!, "Ada");
    const para = store.children("b:" + sub)[0]!;
    const r = await post(`${app.url}/sync/v2/push`, { records: [], deletions: [{ kind: "block", id: sub }, { kind: "block", id: para }] }, { Authorization: `Bearer ${token}` });
    expect(r.body!.rejected ?? []).toEqual([]);
    expect(store.blocks.has(sub)).toBe(false);
  });

  it("über den echten Client: „Delete forever“ eines Gasts wird zurückgerollt", async () => {
    const { app, store, shared, sub } = await setup();
    const secret = app.share.createLink("access", shared, "edit", { kind: "owner" }).secret!;
    const { openNodeDatabase } = await import("@based/sync/node");
    const ws = openWorkspace(openNodeDatabase());
    const client = new SyncClient(ws.store, ws.persistence, { baseURL: app.url, token: secret });
    await client.syncNow();
    expect(ws.store.blocks.has(sub)).toBe(true);
    deleteForever(ws.store, [sub]);
    expect(ws.store.blocks.has(sub)).toBe(false);
    await client.syncNow();
    expect(store.blocks.has(sub)).toBe(true);
    expect(store.children("b:" + sub)).toHaveLength(1);
    expect(ws.store.blocks.has(sub)).toBe(true);
    expect(ws.store.record(keyOf("block", store.children("b:" + sub)[0]!))).toBeDefined();
    client.stop();
  });
});
