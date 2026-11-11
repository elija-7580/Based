// BSD-220 Teil 3: Geräte-Seite von /collab gegen den echten Server – CollabBinder (Abstammung), DocSession im
// Collab-Modus (Records aus dem Y.Doc ableiten, „derived“ = nicht pushen, veraltete Server-Records nicht ins Y.Doc).
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import { createPage, MemoryPersistence, plainText, WorkspaceStore, type Block, type RecordKeyString, type Stamp, type WireRecord } from "@based/core";
import { CollabBinder, DocSession, FRAGMENT, MemoryYDocStore, type CollabConnection } from "@based/editor/headless";
import * as Y from "yjs";
import { sharedConverter } from "../src/collab.js";
import { startApp, TOKEN } from "./helpers.js";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

/** Speicher, der mitschreibt, was als „derived“ (nicht pushen) geschrieben wurde. */
class SpyPersistence extends MemoryPersistence {
  derived: string[] = [];
  pushed: string[] = [];
  override write(u: WireRecord[], d: RecordKeyString[], t: Map<RecordKeyString, Stamp>, local?: boolean, derived?: boolean) {
    for (const r of u) {
      if (derived) this.derived.push(r.data.id);
      else if (local) this.pushed.push(r.data.id);
    }
    super.write(u, d, t);
  }
}

function device(url: string, records: WireRecord[], docs = new MemoryYDocStore()) {
  const persistence = new SpyPersistence(structuredClone(records));
  const store = new WorkspaceStore({ persistence, node: "dev" + Math.random().toString(16).slice(2, 6) });
  const connect = (name: string, doc: Y.Doc): CollabConnection => {
    let ok!: () => void;
    const synced = new Promise<void>((r) => (ok = r));
    const p = new HocuspocusProvider({ url: url.replace("http", "ws") + "/collab", name, token: TOKEN, document: doc, onSynced: () => ok() });
    cleanup.push(() => p.destroy());
    return { synced, destroy: () => p.destroy() };
  };
  const binder = new CollabBinder({ connect, docStore: docs, syncTimeoutMs: 3000 });
  return { store, persistence, binder, docs };
}

const texts = (store: WorkspaceStore, page: string) => store.children("b:" + page).map((id) => plainText(store.blocks.get(id)?.text));

function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText | undefined {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child;
    const found = child instanceof Y.XmlElement ? firstText(child) : undefined;
    if (found) return found;
  }
  return undefined;
}

describe("BSD-220 Teil 3: Gerät an /collab", () => {
  it("lokaler Stand ohne Server-Abstammung wird verworfen; Tippen → derived Records hier, Records auf dem Server; nichts doppelt", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const store = app.sync.store;
    const page = createPage(store, { title: "Echtzeit" });
    const now = store.now();
    store.transact("t", (tx) => tx.put({ kind: "block", data: { id: "h", type: "text", parent: "b:" + page, sk: "a0", text: "Hallo", createdAt: now, updatedAt: now } as Block }));
    const records = store.allRecords();

    // Gerät A hat schon einen lokal gefüllten Y-Stand (vor Echtzeit-Text): andere Items für denselben Text.
    const a = device(app.url, records);
    const local = new DocSession(a.store, page, { converter: sharedConverter(), docStore: a.docs, debounceMs: 0 });
    local.close();
    expect(a.docs.load(page)).toBeDefined();

    const ha = (await a.binder.open(page))!;
    expect(ha).toBeDefined();
    const sa = new DocSession(a.store, page, { converter: sharedConverter(), doc: ha.doc, collab: true, debounceMs: 0, docStore: { load: () => undefined, save: (id, st) => a.docs.save(id, st) } });
    cleanup.push(() => { sa.close(); ha.release(); });
    expect(sharedConverter().fromFragment(ha.doc.getXmlFragment(FRAGMENT)).map((b) => b.id)).toEqual(["h"]);

    const b = device(app.url, records);
    const hb = (await b.binder.open(page))!;
    const sb = new DocSession(b.store, page, { converter: sharedConverter(), doc: hb.doc, collab: true, debounceMs: 0 });
    cleanup.push(() => { sb.close(); hb.release(); });

    // A tippt.
    ha.doc.transact(() => firstText(ha.doc.getXmlFragment(FRAGMENT))!.insert(5, " Welt"));
    expect(texts(a.store, page)).toEqual(["Hallo Welt"]);
    expect(a.persistence.derived).toContain("h");
    expect(a.persistence.pushed).not.toContain("h");
    await expect.poll(() => texts(store, page), { timeout: 5000 }).toEqual(["Hallo Welt"]);
    await expect.poll(() => texts(b.store, page), { timeout: 5000 }).toEqual(["Hallo Welt"]);
    expect(b.persistence.pushed).toEqual([]);
    expect(sharedConverter().fromFragment(hb.doc.getXmlFragment(FRAGMENT)).length).toBe(1);

    // Ein veralteter Record per Sync (älterer Text, neuerer Stempel) dreht das Y.Doc nicht zurück.
    const stale = structuredClone(records.find((r) => r.data.id === "h")!) as WireRecord;
    (stale.data as { stamp: Stamp }).stamp = { millis: Date.now() + 60_000, counter: 0, node: "server" };
    b.store.applyRemote([stale], []);
    expect(firstText(hb.doc.getXmlFragment(FRAGMENT))!.toString()).toBe("Hallo Welt");
    expect(texts(b.store, page)).toEqual(["Hallo Welt"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(texts(store, page)).toEqual(["Hallo Welt"]);
  });

  it("BSD-252: Synced-Block-Original ist eine eigene Wurzel auf /collab; eine Kopie nicht", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const store = app.sync.store;
    const page = createPage(store, { title: "Mit Synced Block" });
    const now = store.now();
    store.transact("t", (tx) => {
      tx.put({ kind: "block", data: { id: "orig", type: "syncedBlock", parent: "b:" + page, sk: "a0", createdAt: now, updatedAt: now } as Block });
      tx.put({ kind: "block", data: { id: "inner", type: "text", parent: "b:orig", sk: "a0", text: "Geteilt", createdAt: now, updatedAt: now } as Block });
      tx.put({ kind: "block", data: { id: "copy", type: "syncedBlock", parent: "b:" + page, sk: "a1", props: { syncSource: "orig" }, createdAt: now, updatedAt: now } as Block });
    });
    const records = store.allRecords();
    const a = device(app.url, records);
    const h = (await a.binder.open("orig"))!;
    expect(h).toBeDefined();
    const s = new DocSession(a.store, "orig", { converter: sharedConverter(), doc: h.doc, collab: true, debounceMs: 0 });
    cleanup.push(() => { s.close(); h.release(); });
    expect(sharedConverter().fromFragment(h.doc.getXmlFragment(FRAGMENT)).map((b) => b.id)).toEqual(["inner"]);
    h.doc.transact(() => firstText(h.doc.getXmlFragment(FRAGMENT))!.insert(7, " live"));
    await expect.poll(() => texts(store, "orig"), { timeout: 5000 }).toEqual(["Geteilt live"]);
    expect(await device(app.url, records).binder.open("copy")).toBeUndefined();
  }, 15_000);

  it("ohne Verbindung (aus) oder ohne Abgleich: kein Collab-Dokument, der Editor arbeitet wie bisher", async () => {
    const off = new CollabBinder({ connect: () => undefined, docStore: new MemoryYDocStore() });
    expect(await off.open("P")).toBeUndefined();
    let destroyed = 0;
    const never = new CollabBinder({
      connect: () => ({ synced: new Promise(() => undefined), destroy: () => void destroyed++ }),
      docStore: new MemoryYDocStore(),
      syncTimeoutMs: 20,
    });
    expect(await never.open("P")).toBeUndefined();
    expect(destroyed).toBe(1);
    expect(never.openRoots).toEqual([]);
    let connects = 0;
    const offline = new CollabBinder({ connect: () => { connects++; return undefined; }, docStore: new MemoryYDocStore(), online: () => false });
    expect(await offline.open("P")).toBeUndefined();
    expect(connects).toBe(0);
  });

  it("BSD-252: noch nicht gepushte lokale Änderungen ohne Server-Stand → ohne /collab öffnen, gar nicht verbinden", async () => {
    let connects = 0;
    const asked: string[] = [];
    const binder = new CollabBinder({
      connect: () => { connects++; return { synced: Promise.resolve(), destroy: () => undefined }; },
      docStore: new MemoryYDocStore(),
      unsynced: async (root) => { asked.push(root); return true; },
    });
    expect(await binder.open("P")).toBeUndefined();
    expect(connects).toBe(0);
    expect(asked).toEqual(["P"]);
    // Fehler bei der Rückfrage zählt wie „noch offen“ (lieber ohne /collab als Text verlieren).
    const failing = new CollabBinder({ connect: () => { connects++; return undefined; }, docStore: new MemoryYDocStore(), unsynced: async () => { throw new Error("worker gone"); } });
    expect(await failing.open("P")).toBeUndefined();
    expect(connects).toBe(0);
  });

  it("gespeicherter Stand vom Server: sofort öffnen (offline), eine Verbindung je Wurzel", async () => {
    const docs = new MemoryYDocStore();
    const server = new Y.Doc();
    server.getMap("based").set("origin", "server");
    docs.save("P", Y.encodeStateAsUpdate(server));
    let connects = 0, destroyed = 0;
    const binder = new CollabBinder({
      connect: () => {
        connects++;
        return { synced: new Promise(() => undefined), destroy: () => void destroyed++ };
      },
      docStore: docs,
    });
    const [h1, h2] = await Promise.all([binder.open("P"), binder.open("P")]);
    expect(h1?.doc).toBe(h2?.doc);
    expect(connects).toBe(1);
    h1!.release();
    expect(destroyed).toBe(0);
    h2!.release();
    expect(destroyed).toBe(1);
  });
});
