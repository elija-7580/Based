// Hocuspocus unter /collab: zwei Provider auf derselben Seite sehen ihre Änderungen live; Zustand bleibt nach
// Neustart erhalten; ohne Token oder für eine unbekannte Seite keine Verbindung.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { afterEach, describe, expect, it } from "vitest";
import { createPage } from "@based/core";
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

describe("Hocuspocus /collab", () => {
  it("zwei Geräte bearbeiten dieselbe Seite live; Zustand überlebt einen Neustart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-collab-"));
    const db = join(dir, "based.sqlite");
    const app = await startApp({ db, collabDebounce: 50 });
    const id = createPage(app.sync.store, { title: "Gemeinsam" });

    const a = provider(app.url, `page:${id}`);
    const b = provider(app.url, `page:${id}`);
    await expect.poll(() => a.p.isSynced && b.p.isSynced, { timeout: 5000 }).toBe(true);

    const para = new Y.XmlElement("paragraph");
    para.insert(0, [new Y.XmlText("Hallo von A")]);
    a.document.getXmlFragment("blocks").insert(0, [para]);
    await expect.poll(() => fragmentText(b.document), { timeout: 5000 }).toContain("Hallo von A");

    await expect.poll(() => app.collab.opts.states.load(`page:${id}`)?.length ?? 0, { timeout: 5000 }).toBeGreaterThan(0);
    a.p.destroy();
    b.p.destroy();
    await app.close();

    const again = await startApp({ db });
    cleanup.push(() => again.close());
    const c = provider(again.url, `page:${id}`);
    await expect.poll(() => fragmentText(c.document), { timeout: 5000 }).toContain("Hallo von A");
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
