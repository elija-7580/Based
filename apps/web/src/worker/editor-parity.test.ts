// Editor-Parität im Store-Worker: Seiten-Angaben und Seitensuche fürs @-Menü, Backlinks, und Synced-Originale von
// anderen Seiten in der Seiten-Replik (beim Öffnen, nach dem Einfügen einer Kopie und über `includeSynced`).
import { keyBetween, type Block } from "@based/core";
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { afterEach, describe, expect, it } from "vitest";
import { StoreHost } from "./host.js";
import type { Event } from "./protocol.js";

let hosts: StoreHost[] = [];
afterEach(() => {
  hosts.forEach((h) => h.stop());
  hosts = [];
});

async function setup() {
  const sent: Event[] = [];
  const db = openNodeDatabase(":memory:");
  const host = new StoreHost({ post: (e) => sent.push(structuredClone(e)), open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent: true }), defer: (fn) => fn() });
  hosts.push(host);
  await host.init(undefined, undefined, undefined);
  const store = host.ws!.store;
  const page = (title: string) => host.command({ op: "createPage", title }) as string;
  const put = (b: Partial<Block> & { id: string; type: string; parent: string }) => {
    const now = store.now();
    const last = store.children(b.parent).at(-1);
    store.transact("t", (tx) => tx.put({ kind: "block", data: { sk: keyBetween(last ? store.blocks.get(last)!.sk : undefined, undefined), createdAt: now, updatedAt: now, ...b } as Block }));
  };
  return { host, store, page, put, sent };
}

describe("Worker: Erwähnungen und Backlinks", () => {
  it("pageInfo, findPages (nur Titel, ohne Papierkorb), backlinks", async () => {
    const { host, page, put } = await setup();
    const zep = page("Project Zeppelin");
    const notes = page("Notes");
    const old = page("Zeppelin archive");
    put({ id: "n1", type: "text", parent: "b:" + notes, text: [{ t: "see " }, { t: "Z", mention: { page: { _0: zep } } }] });
    put({ id: "o1", type: "text", parent: "b:" + old, text: [{ t: "Z", mention: { page: { _0: zep } } }] });
    host.command({ op: "trash", ids: [old] });

    const info = host.pageInfos([zep, old, "nope"]);
    expect(info[zep]).toMatchObject({ id: zep, title: "Project Zeppelin", kind: "page", trashed: false });
    expect(info[old]).toMatchObject({ trashed: true });
    expect(info.nope).toBeNull();

    expect(host.findPages("zeppel").map((p) => p.title)).toEqual(["Project Zeppelin"]);
    expect(host.findPages("")).toEqual([]);

    expect(host.backlinks(zep).map((p) => p.title)).toEqual(["Notes"]);
    // Inkrementell: neue Erwähnung, dann Papierkorb wiederhergestellt
    put({ id: "w1", type: "text", parent: "b:" + host.ws!.store.children("w")[0], text: [{ t: "Z", mention: { page: { _0: zep } } }] });
    host.command({ op: "restore", ids: [old] });
    expect(host.backlinks(zep).map((p) => p.title)).toEqual(["Notes", "Welcome to Based", "Zeppelin archive"]);
  });
});

describe("Worker: Synced Blocks über Seiten", () => {
  it("openPage bringt Originale fremder Seiten samt Inhalt und Vorfahren mit; neue Kopien ziehen nach", async () => {
    const { host, store, page, put, sent } = await setup();
    const src = page("Source");
    const mirror = page("Mirror");
    const third = page("Third");
    put({ id: "orig", type: "syncedBlock", parent: "b:" + src });
    put({ id: "k1", type: "text", parent: "b:orig", text: "shared" });
    put({ id: "copy", type: "syncedBlock", parent: "b:" + mirror, props: { syncSource: "orig" } });

    const opened = host.openPage(mirror);
    const ids = opened.records.filter((r) => r.kind === "block").map((r) => r.data.id);
    expect(ids).toEqual(expect.arrayContaining([mirror, "copy", "orig", "k1", src]));

    // Änderung am Original kommt in der Replik der Kopie an
    sent.length = 0;
    store.transact("edit", (tx) => tx.update("k1", (b) => { b.text = "shared, edited"; }));
    host.flush();
    const changed = sent.flatMap((e) => (e.type === "pageChanges" && e.pageID === mirror ? e.upserts : []));
    expect(changed.map((r) => r.data.id)).toContain("k1");

    // Dritte Seite: Kopie wird eingefügt (wie aus dem Editor) → Original wird nachgeschickt
    host.openPage(third);
    sent.length = 0;
    host.applyLocal([{ kind: "block", data: { id: "copy2", type: "syncedBlock", parent: "b:" + third, sk: "a0", createdAt: 1, updatedAt: 1, props: { syncSource: "orig" } } }], []);
    host.flush();
    const pushed = sent.flatMap((e) => (e.type === "pageChanges" && e.pageID === third ? e.upserts : [])).map((r) => r.data.id);
    expect(pushed).toEqual(expect.arrayContaining(["copy2", "orig", "k1"]));
  });

  it("includeSynced: holt ein Original vor dem Einfügen; unbekannt → found false", async () => {
    const { host, page, put } = await setup();
    const src = page("Source");
    const other = page("Other");
    put({ id: "orig", type: "syncedBlock", parent: "b:" + src });
    put({ id: "k1", type: "text", parent: "b:orig", text: "shared" });
    host.openPage(other);
    const r = host.includeSynced(other, "orig");
    expect(r.found).toBe(true);
    expect(r.records.map((x) => x.data.id)).toEqual(expect.arrayContaining(["orig", "k1", src]));
    expect(host.includeSynced(other, "missing")).toEqual({ found: false, records: [] });
    expect(host.includeSynced(src, "orig")).toEqual({ found: false, records: [] }); // Seite nicht offen
  });
});
