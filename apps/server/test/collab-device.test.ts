// BSD-220 Teil 3: Geräte-Seite von /collab gegen den echten Server – CollabBinder (Abstammung), TextSession als Gerät
// (Records aus dem Y.Doc ableiten, „derived“ = nicht pushen, veraltete Server-Records nicht ins Y.Doc).
// BSD-407 Teil 4c: auf `text:`-Dokumente umgestellt (die alten `page:`-Dokumente nimmt der Server nicht mehr an; der
// Test „Synced-Block-Original als eigene Wurzel“ gehörte zu ihnen und ist entfallen).
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import { createPage, MemoryPersistence, plainText, WorkspaceStore, type Block, type RecordKeyString, type Stamp, type WireRecord } from "@based/core";
import { CollabBinder, MemoryYDocStore, TEXTS, textDocName, TextSession, type CollabConnection } from "@based/editor/headless";
import * as Y from "yjs";
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
  const binder = new CollabBinder({ connect, docStore: docs, syncTimeoutMs: 3000, docName: textDocName });
  return { store, persistence, binder, docs };
}

const texts = (store: WorkspaceStore, page: string) => store.children("b:" + page).map((id) => plainText(store.blocks.get(id)?.text));

const ytext = (doc: Y.Doc, id: string) => doc.getMap<Y.Text>(TEXTS).get(id);

describe("BSD-220 Teil 3: Gerät an /collab", () => {
  it("lokaler Stand ohne Server-Abstammung wird verworfen; Tippen → derived Records hier, Records auf dem Server; nichts doppelt", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const store = app.sync.store;
    const page = createPage(store, { title: "Echtzeit" });
    const now = store.now();
    store.transact("t", (tx) => tx.put({ kind: "block", data: { id: "h", type: "text", parent: "b:" + page, sk: "a0", text: "Hallo", createdAt: now, updatedAt: now } as Block }));
    const records = store.allRecords();

    // Gerät A hat schon einen lokal gefüllten Y-Stand ohne Server-Abstammung: andere Items für denselben Text.
    const a = device(app.url, records);
    const own = new Y.Doc();
    own.getMap<Y.Text>(TEXTS).set("h", new Y.Text("Hallo"));
    a.docs.save(page, Y.encodeStateAsUpdate(own));

    const ha = (await a.binder.open(page))!;
    expect(ha).toBeDefined();
    const sa = new TextSession(a.store, page, { doc: ha.doc, role: "device" });
    cleanup.push(() => { sa.close(); ha.release(); });
    expect([...ha.doc.getMap(TEXTS).keys()]).toEqual(["h"]);
    expect(ytext(ha.doc, "h")!.toString()).toBe("Hallo");

    const b = device(app.url, records);
    const hb = (await b.binder.open(page))!;
    const sb = new TextSession(b.store, page, { doc: hb.doc, role: "device" });
    cleanup.push(() => { sb.close(); hb.release(); });

    // B tippt (Y.Text) → Server-Record; A leitet ab („derived“, nicht gepusht).
    hb.doc.transact(() => ytext(hb.doc, "h")!.insert(5, " Welt"));
    await expect.poll(() => texts(store, page), { timeout: 5000 }).toEqual(["Hallo Welt"]);
    await expect.poll(() => texts(a.store, page), { timeout: 5000 }).toEqual(["Hallo Welt"]);
    expect(a.persistence.derived).toContain("h");
    expect(a.persistence.pushed).not.toContain("h");
    expect(ytext(ha.doc, "h")!.toString()).toBe("Hallo Welt");

    // Ein veralteter Record per Sync (älterer Text, neuerer Stempel) dreht das Y.Doc nicht zurück.
    const stale = structuredClone(records.find((r) => r.data.id === "h")!) as WireRecord;
    (stale.data as { stamp: Stamp }).stamp = { millis: Date.now() + 60_000, counter: 0, node: "server" };
    a.store.applyRemote([stale], []);
    expect(ytext(ha.doc, "h")!.toString()).toBe("Hallo Welt");
    await expect.poll(() => texts(a.store, page), { timeout: 5000 }).toEqual(["Hallo Welt"]);
    await new Promise((r) => setTimeout(r, 300));
    expect(texts(store, page)).toEqual(["Hallo Welt"]);
  });

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
