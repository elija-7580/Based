// Hocuspocus unter /collab: zwei Provider auf derselben Seite sehen ihre Änderungen live; Zustand bleibt nach
// Neustart erhalten; ohne Token oder für eine unbekannte Seite keine Verbindung.
// BSD-220: Der Server füllt das Y.Doc aus den Records (einmal), schreibt Y-Änderungen als Records und übernimmt
// Record-Änderungen ins Y.Doc; zwei Geräte, die offline denselben Absatz ändern, behalten beide Änderungen.
// BSD-407 Teil 4c: alles über `text:<seite>` (ein Y.Text je Textblock); `page:<seite>` wird abgewiesen, gespeicherte
// alte Zustände bleiben in der Datenbank.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import { createPage, plainText, type Block, type WorkspaceStore } from "@based/core";
import { TEXTS } from "@based/editor/headless";
import { META_MAP, META_ORIGIN, RETIRED_DOC_MESSAGE } from "../src/collab.js";
import * as Y from "yjs";
import { startApp, TOKEN } from "./helpers.js";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

function provider(url: string, name: string, token = TOKEN, document = new Y.Doc()) {
  let failed = "";
  const p = new HocuspocusProvider({
    url: url.replace("http", "ws") + "/collab",
    name,
    token,
    document,
    onAuthenticationFailed: ({ reason }) => {
      failed = reason || "denied";
    },
  });
  cleanup.push(() => p.destroy());
  return { p, document, failed: () => failed };
}

const ytext = (d: Y.Doc, id: string) => d.getMap<Y.Text>(TEXTS).get(id);
/** Texte im Y.Doc je Block-ID (sortiert nach ID). */
const yTexts = (d: Y.Doc) => Object.fromEntries([...d.getMap<Y.Text>(TEXTS).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.toString()]));

/** Texte der Kinder einer Seite im Store. */
const storeTexts = (store: WorkspaceStore, page: string) => store.children("b:" + page).map((id) => plainText(store.blocks.get(id)?.text));

/** Kind-Block einer Seite anlegen (wie ein Swift-Client über Sync v2). */
function addChild(store: WorkspaceStore, page: string, id: string, text: string, sk = "a0") {
  const now = store.now();
  store.transact("t", (tx) => tx.put({ kind: "block", data: { id, type: "text", parent: "b:" + page, sk, text, createdAt: now, updatedAt: now } as Block }));
}

describe("Hocuspocus /collab", () => {
  it("zwei Geräte bearbeiten dieselbe Seite live; Zustand überlebt einen Neustart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-collab-"));
    const db = join(dir, "based.sqlite");
    const app = await startApp({ db, collabDebounce: 50 });
    const id = createPage(app.sync.store, { title: "Gemeinsam" });
    addChild(app.sync.store, id, "x1", "");

    const a = provider(app.url, `text:${id}`);
    const b = provider(app.url, `text:${id}`);
    await expect.poll(() => a.p.isSynced && b.p.isSynced && ytext(a.document, "x1") !== undefined, { timeout: 5000 }).toBe(true);

    ytext(a.document, "x1")!.insert(0, "Hallo von A");
    await expect.poll(() => ytext(b.document, "x1")?.toString(), { timeout: 5000 }).toBe("Hallo von A");
    // BSD-220: als Record geschrieben (erreicht so Sync v2 und den Swift-Client).
    await expect.poll(() => storeTexts(app.sync.store, id), { timeout: 5000 }).toEqual(["Hallo von A"]);

    await expect.poll(() => app.collab.opts.states.load(`text:${id}`)?.length ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
    a.p.destroy();
    b.p.destroy();
    await app.close();

    const again = await startApp({ db });
    cleanup.push(() => again.close());
    const c = provider(again.url, `text:${id}`);
    await expect.poll(() => ytext(c.document, "x1")?.toString(), { timeout: 5000 }).toBe("Hallo von A");
  });

  it("BSD-220: der Server füllt das Y.Doc einmal aus den Records – zwei Geräte sehen den Inhalt nicht doppelt", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const id = createPage(app.sync.store, { title: "Vorhanden" });
    addChild(app.sync.store, id, "x1", "Erster Absatz", "a0");
    addChild(app.sync.store, id, "x2", "Zweiter Absatz", "a1");
    const a = provider(app.url, `text:${id}`);
    const b = provider(app.url, `text:${id}`);
    await expect.poll(() => a.p.isSynced && b.p.isSynced, { timeout: 5000 }).toBe(true);
    const expected = { x1: "Erster Absatz", x2: "Zweiter Absatz" };
    await expect.poll(() => yTexts(a.document), { timeout: 5000 }).toEqual(expected);
    await expect.poll(() => yTexts(b.document), { timeout: 5000 }).toEqual(expected);
    expect(a.document.getMap(META_MAP).get(META_ORIGIN)).toBe("server");
    // Laden ändert keine Records.
    expect(storeTexts(app.sync.store, id)).toEqual(["Erster Absatz", "Zweiter Absatz"]);
  });

  it("BSD-220: Record-Änderungen (Sync-Push, MCP) erreichen die Geräte über Yjs", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const id = createPage(app.sync.store, { title: "Swift schreibt" });
    addChild(app.sync.store, id, "x1", "alt");
    const a = provider(app.url, `text:${id}`);
    await expect.poll(() => a.p.isSynced && ytext(a.document, "x1") !== undefined, { timeout: 5000 }).toBe(true);
    app.sync.store.setText("x1", "neu vom Swift-Client");
    addChild(app.sync.store, id, "x2", "dazu", "a5");
    await expect.poll(() => yTexts(a.document), { timeout: 5000 }).toEqual({ x1: "neu vom Swift-Client", x2: "dazu" });
  });

  it("BSD-220: zwei Geräte ändern offline denselben Absatz – nach dem Abgleich sind beide Änderungen da", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-collab-"));
    const db = join(dir, "based.sqlite");
    let app = await startApp({ db, collabDebounce: 50 });
    const id = createPage(app.sync.store, { title: "Konflikt" });
    addChild(app.sync.store, id, "x1", "Hallo Welt");
    const a = provider(app.url, `text:${id}`);
    const b = provider(app.url, `text:${id}`);
    await expect.poll(() => a.p.isSynced && b.p.isSynced && ytext(b.document, "x1") !== undefined, { timeout: 5000 }).toBe(true);
    expect(ytext(a.document, "x1")!.toString()).toBe("Hallo Welt");

    // Beide offline (Server weg), beide ändern denselben Absatz.
    a.p.destroy();
    b.p.destroy();
    await app.close();
    ytext(a.document, "x1")!.insert(0, "A: ");
    const tb = ytext(b.document, "x1")!;
    tb.insert(tb.length, " (B)");

    // Wieder online: dieselben Y.Docs (lokal gespeicherter Stand) verbinden sich neu.
    app = await startApp({ db, collabDebounce: 50 });
    cleanup.push(() => app.close());
    const pa = provider(app.url, `text:${id}`, TOKEN, a.document);
    const pb = provider(app.url, `text:${id}`, TOKEN, b.document);
    await expect.poll(() => pa.p.isSynced && pb.p.isSynced, { timeout: 5000 }).toBe(true);
    await expect.poll(() => ytext(a.document, "x1")!.toString(), { timeout: 5000 }).toBe("A: Hallo Welt (B)");
    await expect.poll(() => ytext(b.document, "x1")!.toString(), { timeout: 5000 }).toBe("A: Hallo Welt (B)");
    await expect.poll(() => storeTexts(app.sync.store, id), { timeout: 5000 }).toEqual(["A: Hallo Welt (B)"]);
    expect(app.sync.store.blocks.get("x1")?.type).toBe("text");
  });

  it("BSD-220: ein Text für einen unbekannten Block oder ein falscher Typ beendet den Server nicht und ändert keine Records", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const id = createPage(app.sync.store, { title: "Kaputt" });
    addChild(app.sync.store, id, "x1", "bleibt");
    const a = provider(app.url, `text:${id}`);
    await expect.poll(() => a.p.isSynced && ytext(a.document, "x1") !== undefined, { timeout: 5000 }).toBe(true);
    const before = app.sync.store.allRecords().length;
    a.document.transact(() => {
      a.document.getMap(TEXTS).set("gibt-es-nicht", new Y.Text("lose"));
      a.document.getMap(TEXTS).set("auch-nicht", new Y.Map() as never);
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(storeTexts(app.sync.store, id)).toEqual(["bleibt"]);
    expect(app.sync.store.allRecords().length).toBe(before);
    expect((await fetch(app.url + "/health")).status).toBeLessThan(500);
  });

  it("falscher Token, unbekannte Seite oder altes Seiten-Dokument (page:): abgewiesen; alter Zustand bleibt gespeichert", async () => {
    const app = await startApp();
    cleanup.push(() => app.close());
    const id = createPage(app.sync.store, { title: "Privat" });
    const wrong = provider(app.url, `text:${id}`, "falsch");
    await expect.poll(() => wrong.failed(), { timeout: 5000 }).not.toBe("");
    const unknown = provider(app.url, "text:gibt-es-nicht");
    await expect.poll(() => unknown.failed(), { timeout: 5000 }).not.toBe("");
    expect(wrong.p.isSynced).toBe(false);
    // BSD-407 Teil 4c: Ein Y-Zustand aus der BlockNote-Zeit liegt noch in der Datenbank – er wird nicht geladen,
    // nicht verändert und nicht gelöscht.
    const old = new Y.Doc();
    old.getXmlFragment("blocks").insert(0, [new Y.XmlElement("blockGroup")]);
    const oldState = Y.encodeStateAsUpdate(old);
    app.collab.opts.states.save(`page:${id}`, oldState);
    const retired = provider(app.url, `page:${id}`);
    await expect.poll(() => retired.failed(), { timeout: 5000 }).not.toBe("");
    // Hocuspocus meldet dem Client nur „permission-denied“; die Meldung steht im Server-Log.
    expect(RETIRED_DOC_MESSAGE).toMatch(/Update Based/);
    expect(retired.p.isSynced).toBe(false);
    expect(app.collab.opts.states.load(`page:${id}`)).toEqual(oldState);
    expect(app.collab.sessions.size).toBe(0);
  });

  it("andere WebSocket-Pfade: 404", async () => {
    const app = await startApp();
    cleanup.push(() => app.close());
    const ws = new WebSocket(app.url.replace("http", "ws") + "/anders");
    const result = await new Promise<string>((r) => {
      ws.onerror = () => r("error");
      ws.onopen = () => r("open");
    });
    expect(result).toBe("error");
  });
});
