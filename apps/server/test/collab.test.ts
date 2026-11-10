// Hocuspocus unter /collab: zwei Provider auf derselben Seite sehen ihre Änderungen live; Zustand bleibt nach
// Neustart erhalten; ohne Token oder für eine unbekannte Seite keine Verbindung.
// BSD-220: Der Server füllt das Y.Doc aus den Records (einmal), schreibt Y-Änderungen als Records und übernimmt
// Record-Änderungen ins Y.Doc; zwei Geräte, die offline denselben Absatz ändern, behalten beide Änderungen.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import { createPage, plainText, type Block, type WorkspaceStore } from "@based/core";
import { META_MAP, META_ORIGIN, sharedConverter } from "../src/collab.js";
import * as Y from "yjs";
import { startApp, TOKEN } from "./helpers.js";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

function provider(url: string, name: string, token = TOKEN) {
  const document = new Y.Doc();
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

const fragmentText = (d: Y.Doc) => d.getXmlFragment("blocks").toString();

/** Text des ersten Absatzes im Dokument (ein leerer Absatz hat noch keinen Y.XmlText: dann anlegen). */
function firstText(node: Y.XmlFragment | Y.XmlElement): Y.XmlText | undefined {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child;
    if (child instanceof Y.XmlElement && child.nodeName === "paragraph" && child.length === 0) {
      const t = new Y.XmlText();
      child.insert(0, [t]);
      return t;
    }
    const found = child instanceof Y.XmlElement ? firstText(child) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** Blöcke im Y.Doc (Typ + Text), über den Konverter des Servers gelesen. */
const yBlocks = (d: Y.Doc) => sharedConverter().fromFragment(d.getXmlFragment("blocks")).map((b) => ({
  id: b.id,
  type: b.type,
  text: Array.isArray(b.content) ? b.content.map((c) => ("text" in c ? c.text : "")).join("") : "",
}));

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

    const a = provider(app.url, `page:${id}`);
    const b = provider(app.url, `page:${id}`);
    await expect.poll(() => a.p.isSynced && b.p.isSynced, { timeout: 5000 }).toBe(true);

    // Der Server hat die leere Seite mit einem Absatz gefüllt; A schreibt hinein.
    firstText(a.document.getXmlFragment("blocks"))!.insert(0, "Hallo von A");
    await expect.poll(() => fragmentText(b.document), { timeout: 5000 }).toContain("Hallo von A");
    // BSD-220: als Record geschrieben (erreicht so Sync v2 und den Swift-Client).
    await expect.poll(() => storeTexts(app.sync.store, id), { timeout: 5000 }).toEqual(["Hallo von A"]);

    await expect.poll(() => app.collab.opts.states.load(`page:${id}`)?.length ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
    a.p.destroy();
    b.p.destroy();
    await app.close();

    const again = await startApp({ db });
    cleanup.push(() => again.close());
    const c = provider(again.url, `page:${id}`);
    await expect.poll(() => fragmentText(c.document), { timeout: 5000 }).toContain("Hallo von A");
  });

  it("BSD-220: der Server füllt das Y.Doc einmal aus den Records – zwei Geräte sehen den Inhalt nicht doppelt", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const id = createPage(app.sync.store, { title: "Vorhanden" });
    addChild(app.sync.store, id, "x1", "Erster Absatz", "a0");
    addChild(app.sync.store, id, "x2", "Zweiter Absatz", "a1");
    const a = provider(app.url, `page:${id}`);
    const b = provider(app.url, `page:${id}`);
    await expect.poll(() => a.p.isSynced && b.p.isSynced, { timeout: 5000 }).toBe(true);
    const expected = [{ id: "x1", type: "paragraph", text: "Erster Absatz" }, { id: "x2", type: "paragraph", text: "Zweiter Absatz" }];
    expect(yBlocks(a.document)).toEqual(expected);
    expect(yBlocks(b.document)).toEqual(expected);
    expect(a.document.getMap(META_MAP).get(META_ORIGIN)).toBe("server");
    // Laden ändert keine Records.
    expect(storeTexts(app.sync.store, id)).toEqual(["Erster Absatz", "Zweiter Absatz"]);
  });

  it("BSD-220: Record-Änderungen (Sync-Push, MCP) erreichen die Geräte über Yjs", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const id = createPage(app.sync.store, { title: "Swift schreibt" });
    addChild(app.sync.store, id, "x1", "alt");
    const a = provider(app.url, `page:${id}`);
    await expect.poll(() => a.p.isSynced, { timeout: 5000 }).toBe(true);
    app.sync.store.setText("x1", "neu vom Swift-Client");
    addChild(app.sync.store, id, "x2", "dazu", "a5");
    await expect.poll(() => yBlocks(a.document).map((x) => x.text), { timeout: 5000 }).toEqual(["neu vom Swift-Client", "dazu"]);
  });

  it("BSD-220: zwei Geräte ändern offline denselben Absatz – nach dem Abgleich sind beide Änderungen da", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-collab-"));
    const db = join(dir, "based.sqlite");
    let app = await startApp({ db, collabDebounce: 50 });
    const id = createPage(app.sync.store, { title: "Konflikt" });
    addChild(app.sync.store, id, "x1", "Hallo Welt");
    const a = provider(app.url, `page:${id}`);
    const b = provider(app.url, `page:${id}`);
    await expect.poll(() => a.p.isSynced && b.p.isSynced, { timeout: 5000 }).toBe(true);
    expect(yBlocks(a.document).map((x) => x.text)).toEqual(["Hallo Welt"]);

    // Beide offline (Server weg), beide ändern denselben Absatz.
    a.p.destroy();
    b.p.destroy();
    await app.close();
    firstText(a.document.getXmlFragment("blocks"))!.insert(0, "A: ");
    const tb = firstText(b.document.getXmlFragment("blocks"))!;
    tb.insert(tb.length, " (B)");

    // Wieder online: dieselben Y.Docs (lokal gespeicherter Stand) verbinden sich neu.
    app = await startApp({ db, collabDebounce: 50 });
    cleanup.push(() => app.close());
    const reconnect = (document: Y.Doc) => {
      const p = new HocuspocusProvider({ url: app.url.replace("http", "ws") + "/collab", name: `page:${id}`, token: TOKEN, document });
      cleanup.push(() => p.destroy());
      return p;
    };
    const pa = reconnect(a.document);
    const pb = reconnect(b.document);
    await expect.poll(() => pa.isSynced && pb.isSynced, { timeout: 5000 }).toBe(true);
    await expect.poll(() => yBlocks(a.document).map((x) => x.text), { timeout: 5000 }).toEqual(["A: Hallo Welt (B)"]);
    await expect.poll(() => yBlocks(b.document).map((x) => x.text), { timeout: 5000 }).toEqual(["A: Hallo Welt (B)"]);
    await expect.poll(() => storeTexts(app.sync.store, id), { timeout: 5000 }).toEqual(["A: Hallo Welt (B)"]);
    expect(app.sync.store.blocks.get("x1")?.type).toBe("text");
  });

  it("BSD-220: ein Update, das nicht zum Schema passt, beendet den Server nicht und ändert keine Records", async () => {
    const app = await startApp({ collabDebounce: 50 });
    cleanup.push(() => app.close());
    const id = createPage(app.sync.store, { title: "Kaputt" });
    addChild(app.sync.store, id, "x1", "bleibt");
    const a = provider(app.url, `page:${id}`);
    await expect.poll(() => a.p.isSynced, { timeout: 5000 }).toBe(true);
    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("lose")]);
    a.document.getXmlFragment("blocks").insert(0, [para]);
    await new Promise((r) => setTimeout(r, 300));
    expect(storeTexts(app.sync.store, id)).toEqual(["bleibt"]);
    expect((await fetch(app.url + "/health")).status).toBeLessThan(500);
  });

  it("falscher Token oder unbekannte Seite: abgewiesen", async () => {
    const app = await startApp();
    cleanup.push(() => app.close());
    const id = createPage(app.sync.store, { title: "Privat" });
    const wrong = provider(app.url, `page:${id}`, "falsch");
    await expect.poll(() => wrong.failed(), { timeout: 5000 }).not.toBe("");
    const unknown = provider(app.url, "page:gibt-es-nicht");
    await expect.poll(() => unknown.failed(), { timeout: 5000 }).not.toBe("");
    expect(wrong.p.isSynced).toBe(false);
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
