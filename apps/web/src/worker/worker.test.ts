// BSD-153: Nachrichten-Schnittstelle zwischen UI und Store-Worker – Host und Client über einen Testkanal
// (strukturiert geklont und asynchron wie bei postMessage), Speicher über node:sqlite statt OPFS.
import { buildOutline, sectionKey, type WireRecord } from "@based/core";
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { afterEach, describe, expect, it } from "vitest";
import { StoreClient } from "./client.js";
import { StoreHost } from "./host.js";
import type { Endpoint, Event, RequestMessage } from "./protocol.js";

type Fn<T> = (e: { data: T }) => void;

/** Zwei Enden eines Kanals; Nachrichten werden geklont und als eigener Task zugestellt. */
function channel() {
  const toHost = new Set<Fn<RequestMessage>>();
  const toClient = new Set<Fn<Event>>();
  const sent: Event[] = [];
  const clientEnd: Endpoint<Event, RequestMessage> = {
    postMessage: (m) => setTimeout(() => toHost.forEach((f) => f({ data: structuredClone(m) }))),
    addEventListener: (_t, f) => toClient.add(f),
    removeEventListener: (_t, f) => toClient.delete(f),
  };
  const postToClient = (e: Event) => {
    sent.push(e);
    const copy = structuredClone(e);
    setTimeout(() => toClient.forEach((f) => f({ data: copy })));
  };
  return { clientEnd, toHost, postToClient, sent };
}

let hosts: StoreHost[] = [];
afterEach(() => {
  hosts.forEach((h) => h.stop());
  hosts = [];
});

function setup(dbFile = ":memory:") {
  const ch = channel();
  const db = openNodeDatabase(dbFile);
  const host = new StoreHost({
    post: ch.postToClient,
    open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent: true }),
    defer: (fn) => setTimeout(fn, 0),
  });
  hosts.push(host);
  let queue = Promise.resolve();
  ch.toHost.add((e) => { queue = queue.then(() => host.handle(e.data)); });
  const client = new StoreClient(ch.clientEnd);
  const devices: string[] = [];
  client.onDevice = (n) => devices.push(n);
  return { host, client, sent: ch.sent, devices, db };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("Store-Worker-Schnittstelle", () => {
  it("Erststart: Willkommensseite, Struktur, Titel, Status, Gerätekennung", async () => {
    const { client, devices } = setup();
    const r = await client.init({});
    await settle();
    expect(r.created).toBe(true);
    expect(devices).toEqual([r.node]);
    const s = client.getState();
    expect(s.ready).toBe(true);
    expect(s.outline?.children[sectionKey("private")]).toEqual([r.homePageID]);
    expect(client.title(r.homePageID!)).toBe("Welcome to Based");
    expect(s.status.state).toBe("local");
  });

  it("Befehle: anlegen, umbenennen, Papierkorb, wiederherstellen, endgültig löschen", async () => {
    const { client, sent } = setup();
    await client.init({ device: "DEV00001" });
    const id = await client.command<string>({ op: "createPage", title: "Plan" });
    const child = await client.command<string>({ op: "createPage", parent: id });
    await settle();
    expect(client.getState().outline?.children[id]).toEqual([child]);

    // Umbenennen schickt nur Titel, keine neue Struktur
    const outlinesBefore = sent.filter((e) => e.type === "outline").length;
    await client.command({ op: "rename", id, title: "Plan B" });
    await settle();
    expect(sent.filter((e) => e.type === "outline").length).toBe(outlinesBefore);
    expect(sent.filter((e) => e.type === "titles").at(-1)).toEqual({ type: "titles", titles: { [id]: "Plan B" }, full: false });
    expect(client.title(id)).toBe("Plan B");

    await client.command({ op: "trash", ids: [id] });
    await settle();
    expect(client.getState().outline?.nodes[id]).toBeUndefined();
    expect(client.getState().outline?.trash.map((t) => t.id)).toEqual([id]);
    await client.command({ op: "restore", ids: [id] });
    await settle();
    expect(client.getState().outline?.children[id]).toEqual([child]);
    await client.command({ op: "trash", ids: [id] });
    await client.command({ op: "deleteForever", ids: [id] });
    await settle();
    expect(client.getState().outline?.trash).toEqual([]);
    expect(client.getState().titles.has(child)).toBe(false);
  });

  it("Ziehen und Favoriten ändern die Struktur", async () => {
    const { client } = setup();
    const { homePageID } = await client.init({});
    const a = await client.command<string>({ op: "createPage", title: "A" });
    await client.command({ op: "drop", ids: [a], target: homePageID!, zone: "before" });
    await client.command({ op: "favorite", ids: [a], on: true });
    await settle();
    const o = client.getState().outline!;
    expect(o.children[sectionKey("private")]).toEqual([a, homePageID]);
    expect(o.favorites).toEqual([a]);
  });

  it("Quick Find: Treffer mit Pfad; neuere Suche bricht ältere ab", async () => {
    const { client } = setup();
    await client.init({});
    await client.command({ op: "seed", count: 300 });
    const parent = await client.command<string>({ op: "createPage", title: "Statistics" });
    await client.command({ op: "createPage", parent, title: "Lecture 4" });
    await client.warmSearch();
    const first = client.search("Page 01");
    const second = client.search("lecture");
    expect(await first).toBeUndefined();
    const r = await second;
    expect(r?.hits[0]).toMatchObject({ title: "Lecture 4", path: "Statistics", kind: "page" });
    const content = await client.search("topic 123");
    expect(content?.hits[0]).toMatchObject({ title: "Page 123" });
    expect(content?.hits[0]?.snippet).toContain("topic 123");
    expect(content!.took).toBeLessThan(50);
  });

  it("Seiten-Replik: Bearbeiten speichert im Worker, Worker-Änderungen kommen an", async () => {
    const { client, host } = setup();
    const { homePageID } = await client.init({});
    const page = await client.openPage(homePageID!);
    const first = page.store.children("b:" + homePageID)[0]!;
    page.store.setText(first, "Edited in the replica");
    await settle();
    expect(host.ws!.store.blocks.get(first)?.text).toBe("Edited in the replica");
    // Echo überschreibt nichts, Replik bleibt gleich
    expect(page.store.blocks.get(first)?.text).toBe("Edited in the replica");

    await client.command({ op: "rename", id: homePageID!, title: "Hello" });
    await settle();
    expect(page.store.blocks.get(homePageID!)?.text).toBe("Hello");
    const sub = await client.command<string>({ op: "createPage", parent: homePageID! });
    await settle();
    expect(page.store.blocks.has(sub)).toBe(true);
    await client.command({ op: "deleteForever", ids: [sub] });
    await settle();
    expect(page.store.blocks.has(sub)).toBe(false);

    // Undo in der Replik geht auch an den Worker
    page.store.undo();
    await settle();
    expect(host.ws!.store.blocks.get(first)?.text).not.toBe("Edited in the replica");
    page.close();
  });

  it("Neu öffnen behält die Daten (gleiche Datei)", async () => {
    const file = `/tmp/based-shell-${crypto.randomUUID()}.sqlite`;
    const one = setup(file);
    await one.client.init({ device: "DEV00001" });
    const id = await one.client.command<string>({ op: "createPage", title: "Kept" });
    one.db.close();
    const two = setup(file);
    const r = await two.client.init({ device: "DEV00001" });
    await settle();
    expect(r.created).toBe(false);
    expect(two.client.title(id)).toBe("Kept");
    expect(r.node).toBe("DEV00001");
  });

  it("Sync: Status Synced bzw. Offline", async () => {
    const records: WireRecord[] = [];
    const ok: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/push")) {
        const body = JSON.parse(String(init?.body)) as { records: WireRecord[] };
        records.push(...body.records);
        return new Response(JSON.stringify({ newer: [], seq: records.length }));
      }
      if (url.includes("/pull")) return new Response(JSON.stringify({ records: [], deletions: [], next: records.length, more: false }));
      if (url.includes("/info")) return new Response(JSON.stringify({ protocol: 2, seq: records.length }));
      return new Promise<Response>(() => undefined); // wait: hängt
    };
    const ch = channel();
    const db = openNodeDatabase();
    let online = true;
    let fail = false;
    const host = new StoreHost({
      post: ch.postToClient,
      open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent: true }),
      fetch: (i, init) => (fail ? Promise.reject(new TypeError("Failed to fetch")) : ok(i, init)),
      online: () => online,
      syncTiming: { intervalMs: 60_000, pushDelayMs: 1 },
    });
    hosts.push(host);
    ch.toHost.add((e) => void host.handle(e.data));
    const client = new StoreClient(ch.clientEnd);
    await client.init({ sync: { url: "https://sync.example", token: "t" } });
    await client.command({ op: "createPage", title: "Pushed" });
    await new Promise((r) => setTimeout(r, 40));
    expect(client.getState().status.state).toBe("synced");
    expect(records.some((r) => r.kind === "block" && r.data.text === "Pushed")).toBe(true);
    fail = true;
    online = false;
    await client.syncNow();
    await settle();
    expect(client.getState().status.state).toBe("offline");
    await client.setSync(undefined);
    await settle();
    expect(client.getState().status.state).toBe("local");
  });

  it("Struktur des Hosts entspricht buildOutline", async () => {
    const { client, host } = setup();
    await client.init({});
    await client.command({ op: "seed", count: 20 });
    await settle();
    expect(client.getState().outline).toEqual(buildOutline(host.ws!.store));
  });
});
