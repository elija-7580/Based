// ADR 0016 (E7): Echtzeit-Text des neuen Block-Editors gegen den echten Server – Dokument `text:<seite>` mit einem
// Y.Text je Textblock (TextSession), Migration vom alten Seiten-Dokument `page:<seite>`, zwei Geräte gleichzeitig,
// Präsenz über Awareness (Feld `node` = Teilnehmer).
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import { blockCommands as cmd, createPage, MemoryPersistence, plainText, WorkspaceStore, type Block, type RecordKeyString, type WireRecord } from "@based/core";
import { CollabBinder, DocSession, FRAGMENT, MemoryYDocStore, TEXTS, textDocName, TextSession, type CollabConnection } from "@based/editor/headless";
import * as Y from "yjs";
import { sharedConverter } from "../src/collab.js";
import { startApp, TOKEN } from "./helpers.js";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

function device(url: string, records: WireRecord[], server: WorkspaceStore) {
  const node = "dev" + Math.random().toString(16).slice(2, 6);
  const store = new WorkspaceStore({ persistence: new MemoryPersistence(structuredClone(records)), node });
  const connect = (name: string, doc: Y.Doc): CollabConnection => {
    let ok!: () => void;
    const synced = new Promise<void>((r) => (ok = r));
    const p = new HocuspocusProvider({ url: url.replace("http", "ws") + "/collab", name, token: TOKEN, document: doc, onSynced: () => ok() });
    p.awareness?.setLocalStateField("node", node);
    cleanup.push(() => p.destroy());
    return { synced, destroy: () => p.destroy(), presence: p.awareness ?? undefined };
  };
  const binder = new CollabBinder({ connect, docStore: new MemoryYDocStore(), syncTimeoutMs: 3000, docName: textDocName });
  // Sync v2 im Kleinen: lokale Änderungen des Geräts gehen an den Server (wie der Sync-Client, etwas später).
  store.observe((ch) => {
    if (ch.origin !== "local" && ch.origin !== "undo" && ch.origin !== "redo") return;
    const recs = ch.keys.map((k) => store.record(k)).filter((r): r is WireRecord => r !== undefined);
    const del = ch.keys.filter((k: RecordKeyString) => store.record(k) === undefined);
    setTimeout(() => server.applyRemote(recs, del), 30);
  });
  return { store, binder, node };
}

const text = (s: WorkspaceStore, id: string) => plainText(s.blocks.get(id)?.text);

describe("ADR 0016 E7: text:<seite> auf /collab", () => {
  it("Migration: altes Seiten-Dokument wird zu Records, das neue Dokument hat denselben Text", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const store = app.sync.store;
    const page = createPage(store, { title: "Alt" });
    const now = store.now();
    store.transact("t", (tx) => {
      tx.put({ kind: "block", data: { id: "h", type: "text", parent: "b:" + page, sk: "a0", text: "Hallo", createdAt: now, updatedAt: now } as Block });
      tx.put({ kind: "block", data: { id: "q", type: "quote", parent: "b:" + page, sk: "a1", text: [{ t: "fett", m: { b: true } }], createdAt: now, updatedAt: now } as Block });
    });
    const records = store.allRecords();

    // Gerät mit dem alten Editor tippt über das Seiten-Dokument (y-prosemirror).
    const old = new CollabBinder({
      connect: (name, doc) => {
        let ok!: () => void;
        const synced = new Promise<void>((r) => (ok = r));
        const p = new HocuspocusProvider({ url: app.url.replace("http", "ws") + "/collab", name, token: TOKEN, document: doc, onSynced: () => ok() });
        cleanup.push(() => p.destroy());
        return { synced, destroy: () => p.destroy() };
      },
      docStore: new MemoryYDocStore(),
      syncTimeoutMs: 3000,
    });
    const oldStore = new WorkspaceStore({ persistence: new MemoryPersistence(structuredClone(records)), node: "old" });
    const ho = (await old.open(page))!;
    const so = new DocSession(oldStore, page, { converter: sharedConverter(), doc: ho.doc, collab: true, debounceMs: 0 });
    cleanup.push(() => { so.close(); ho.release(); });
    const frag = ho.doc.getXmlFragment(FRAGMENT);
    const firstText = (node: Y.XmlFragment | Y.XmlElement): Y.XmlText | undefined => {
      for (const c of node.toArray()) {
        if (c instanceof Y.XmlText) return c;
        const f = c instanceof Y.XmlElement ? firstText(c) : undefined;
        if (f) return f;
      }
      return undefined;
    };
    ho.doc.transact(() => firstText(frag)!.insert(5, " aus dem alten Editor"));

    // Neues Dokument: gefüllt aus den Records, die der Server aus dem alten materialisiert.
    const a = device(app.url, records, store);
    await expect.poll(() => text(store, "h"), { timeout: 5000 }).toBe("Hallo aus dem alten Editor");
    const ha = (await a.binder.open(page))!;
    expect(ha).toBeDefined();
    const sa = new TextSession(a.store, page, { doc: ha.doc, role: "device" });
    cleanup.push(() => { sa.close(); ha.release(); });
    const texts = ha.doc.getMap<Y.Text>(TEXTS);
    expect([...texts.keys()].sort()).toEqual(["h", "q"]);
    expect(texts.get("h")!.toString()).toBe("Hallo aus dem alten Editor");
    expect(text(a.store, "h")).toBe("Hallo aus dem alten Editor");
    expect(a.store.blocks.get("q")!.text).toEqual([{ t: "fett", m: { b: true } }]);

    // Neuer Editor tippt → Records auf dem Server → altes Dokument zieht nach.
    cmd.replaceText(a.store, { blockId: "q", from: 4, to: 4 }, "!");
    await expect.poll(() => text(store, "q"), { timeout: 5000 }).toBe("fett!");
    await expect.poll(() => text(oldStore, "q"), { timeout: 5000 }).toBe("fett!");
  }, 20_000);

  it("zwei Geräte tippen gleichzeitig in denselben Block; Server-Records und beide Geräte gleich; Präsenz", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const store = app.sync.store;
    const page = createPage(store, { title: "Zusammen" });
    const now = store.now();
    store.transact("t", (tx) => tx.put({ kind: "block", data: { id: "p", type: "text", parent: "b:" + page, sk: "a0", text: "Mitte", createdAt: now, updatedAt: now } as Block }));
    const records = store.allRecords();
    const a = device(app.url, records, store), b = device(app.url, records, store);
    const ha = (await a.binder.open(page))!, hb = (await b.binder.open(page))!;
    const sa = new TextSession(a.store, page, { doc: ha.doc, role: "device" });
    const sb = new TextSession(b.store, page, { doc: hb.doc, role: "device" });
    cleanup.push(() => { sa.close(); sb.close(); ha.release(); hb.release(); });

    for (let i = 0; i < 5; i++) {
      cmd.replaceText(a.store, { blockId: "p", from: 0, to: 0 }, "a");
      cmd.replaceText(b.store, { blockId: "p", from: text(b.store, "p").length, to: text(b.store, "p").length }, "b");
    }
    const want = "aaaaaMittebbbbb";
    await expect.poll(() => text(store, "p"), { timeout: 5000 }).toBe(want);
    await expect.poll(() => [text(a.store, "p"), text(b.store, "p")], { timeout: 5000 }).toEqual([want, want]);
    // Veraltete Records der Geräte (kommen 30 ms später) drehen nichts zurück.
    await new Promise((r) => setTimeout(r, 300));
    expect([text(store, "p"), text(a.store, "p"), text(b.store, "p")]).toEqual([want, want, want]);

    // Präsenz: B sieht A in Block p.
    ha.presence!.setLocalStateField("cursor", { block: "p", from: 2, to: 2 });
    await expect.poll(() => [...hb.presence!.getStates().values()].some((s) => (s.cursor as { block?: string } | undefined)?.block === "p" && s.node === a.node), { timeout: 5000 }).toBe(true);
  }, 20_000);
});
