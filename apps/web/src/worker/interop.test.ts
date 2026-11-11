// Worker-Teile von Quick Find (inkrementeller Volltextindex), Import (Vorbereitung → Store-Worker) und Export.
import { readFileSync } from "node:fs";
import { readZipEntries, zipEntryData } from "@based/core";
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { afterEach, describe, expect, it } from "vitest";
import { StoreClient } from "./client.js";
import { StoreHost } from "./host.js";
import { ImportCancelledError, prepareInWorker, type ImportWorkerEvent, type ImportWorkerLike, type ImportWorkerRequest } from "./importClient.js";
import { prepareFiles, type ImportFile } from "./importer.js";
import type { Endpoint, Event, RequestMessage } from "./protocol.js";

type Fn<T> = (e: { data: T }) => void;
let hosts: StoreHost[] = [];
afterEach(() => {
  hosts.forEach((h) => h.stop());
  hosts = [];
});

/** Host und Client über einen Kanal mit structuredClone (wie postMessage). */
function setup() {
  const toHost = new Set<Fn<RequestMessage>>();
  const toClient = new Set<Fn<Event>>();
  const end: Endpoint<Event, RequestMessage> = {
    postMessage: (m) => setTimeout(() => toHost.forEach((f) => f({ data: structuredClone(m) }))),
    addEventListener: (_t, f) => toClient.add(f),
    removeEventListener: (_t, f) => toClient.delete(f),
  };
  const db = openNodeDatabase(":memory:");
  const host = new StoreHost({
    post: (e) => { const c = structuredClone(e); setTimeout(() => toClient.forEach((f) => f({ data: c }))); },
    open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent: true }),
    defer: (fn) => setTimeout(fn, 0),
  });
  hosts.push(host);
  let queue = Promise.resolve();
  toHost.add((e) => { queue = queue.then(() => host.handle(e.data)); });
  return { host, client: new StoreClient(end) };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

interface FixtureFile { path: string; text?: string; base64?: string }
/** Notion-HTML-Export aus fixtures/import (erster Fall: Seiten, Unterseiten, Datenbank, Bilder). */
function notionExport(): ImportFile[] {
  const fx = JSON.parse(readFileSync(new URL("../../../../fixtures/import/notion-html.utc.json", import.meta.url), "utf8")) as { cases: { input: { files?: FixtureFile[] } }[] };
  return fx.cases[0]!.input.files!.map((f) => ({ path: "Export/" + f.path, data: f.base64 !== undefined ? Uint8Array.from(Buffer.from(f.base64, "base64")) : new TextEncoder().encode(f.text ?? "") }));
}

const titles = (client: StoreClient) => [...client.getState().titles.values()];

describe("Quick Find (Volltextindex im Worker)", () => {
  it("baut den Index einmal und arbeitet Änderungen inkrementell ein", async () => {
    const { client, host } = setup();
    const { homePageID } = await client.init({});
    await client.command({ op: "seed", count: 2000 });
    await client.warmSearch();
    const index = host.searchIndex();
    const r = await client.search("topic 0042");
    expect(r?.hits[0]?.title).toBe("Page 0042");
    expect(r?.hits[0]?.snippet).toContain("topic 0042");

    // Text im Seiteninhalt ändern (über die Replik wie der Editor)
    const page = await client.openPage(homePageID!);
    const first = page.store.children("b:" + homePageID)[0]!;
    page.store.setText(first, "Quarterly zeppelin maintenance checklist");
    await settle();
    const hit = await client.search("zeppelin");
    expect(hit?.hits.map((h) => h.title)).toEqual(["Welcome to Based"]);
    expect(hit?.hits[0]?.snippet).toBe("Quarterly zeppelin maintenance checklist");
    expect(host.searchIndex()).toBe(index); // nicht neu gebaut
    expect(hit!.took).toBeLessThan(50);

    // Papierkorb nimmt die Seite aus den Treffern
    await client.command({ op: "trash", ids: [homePageID!] });
    expect((await client.search("zeppelin"))?.hits).toEqual([]);
    page.close();
  });

  it("neuere Suche bricht eine laufende ab", async () => {
    const { client } = setup();
    await client.init({});
    await client.command({ op: "seed", count: 50 });
    const a = client.search("Page 01");
    const b = client.search("topic 7");
    expect(await a).toBeUndefined();
    expect((await b)?.hits.length).toBeGreaterThan(0);
  });
});

describe("Import", () => {
  it("Notion-HTML-Export: vorbereiten, schreiben, Reimport ohne Dubletten", async () => {
    const payload = structuredClone(prepareFiles(notionExport()));
    expect(payload.notion).toBeDefined();
    const { client, host } = setup();
    await client.init({});
    const s = await client.commitImport(payload);
    await settle();
    expect(s.pages).toBe(2);
    expect(s.databases).toBeGreaterThanOrEqual(1);
    expect(s.warnings.some((w) => w.includes("not imported"))).toBe(true); // Bilder ohne Dateispeicher
    expect(titles(client)).toEqual(expect.arrayContaining(["Home", "Sub", "People", "Write docs"]));
    expect(s.rootIDs.length).toBeGreaterThan(0);

    // Volltextsuche findet importierten Inhalt
    const found = await client.search("Purple line");
    expect(found?.hits[0]?.title).toBe("Home");

    // Reimport: gleiche Seiten, keine zweite Kopie
    const count = host.ws!.store.blocks.size;
    const again = await client.commitImport(structuredClone(prepareFiles(notionExport())));
    expect(host.ws!.store.blocks.size).toBe(count);
    expect(again.warnings.some((w) => w.startsWith("Updated"))).toBe(true);
    expect(titles(client).filter((t) => t === "Home")).toHaveLength(1);
  });

  it("Markdown/CSV und unbekannte Dateien", async () => {
    const enc = new TextEncoder();
    const payload = prepareFiles([
      { path: "Notes.md", data: enc.encode("# Notes\n\nBuy oat milk\n") },
      { path: "Budget.xlsx", data: new Uint8Array([1, 2, 3]) },
    ]);
    const { client } = setup();
    await client.init({});
    const s = await client.commitImport(payload);
    await settle();
    expect(s.pages).toBe(1);
    expect(s.warnings.join("\n")).toContain("Skipped Budget.xlsx");
    expect(titles(client)).toContain("Notes");
  });

  it("Based-Archiv: Export und Import in einen anderen Workspace (Herkunft import, Stempel bleiben)", async () => {
    const a = setup();
    await a.client.init({});
    const id = await a.client.command<string>({ op: "createPage", title: "Archived page" });
    const file = await a.client.exportWorkspace("archive");
    expect(file.name).toMatch(/\.based\.zip$/);
    const payload = prepareFiles([{ path: file.name, data: file.data }]);
    expect(payload.archives).toHaveLength(1);

    const b = setup();
    await b.client.init({});
    const origins: string[] = [];
    b.host.ws!.store.observe((c) => origins.push(c.origin));
    const s = await b.client.commitImport(payload);
    await settle();
    expect(s.archiveRecords).toBeGreaterThan(0);
    expect(b.client.title(id)).toBe("Archived page");
    expect(origins).toContain("import");
    expect(b.host.ws!.store.blocks.get(id)?.stamp).toEqual(a.host.ws!.store.blocks.get(id)?.stamp);
    expect(b.host.ws!.store.canUndo).toBe(false);
  });

  it("Vorbereitung im Worker: Fortschritt, Ergebnis, Abbrechen beendet den Worker", async () => {
    const fake = (respond: boolean) => {
      const fns = new Set<(e: { data: ImportWorkerEvent }) => void>();
      const w: ImportWorkerLike & { terminated: boolean } = {
        terminated: false,
        postMessage: (m: ImportWorkerRequest) => {
          if (!respond) return;
          setTimeout(() => {
            const payload = prepareFiles(m.files.map((f) => ({ path: f.path, data: f.data! })), { progress: (f) => fns.forEach((fn) => fn({ data: { type: "progress", fraction: f } })) });
            fns.forEach((fn) => fn({ data: { type: "done", payload } }));
          });
        },
        addEventListener: (_t, fn) => fns.add(fn),
        terminate() { this.terminated = true; },
      };
      return w;
    };
    const progress: number[] = [];
    const w1 = fake(true);
    const ok = prepareInWorker([{ path: "a.md", data: new TextEncoder().encode("# A") }], (f) => progress.push(f), () => w1);
    expect((await ok.result).notion).toBeDefined();
    expect(progress.at(-1)).toBe(1);
    expect(w1.terminated).toBe(true);

    const w2 = fake(false);
    const job = prepareInWorker([{ path: "a.md", data: new TextEncoder().encode("# A") }], () => undefined, () => w2);
    job.cancel();
    await expect(job.result).rejects.toBeInstanceOf(ImportCancelledError);
    expect(w2.terminated).toBe(true);
  });
});

describe("Import-Worker: Bestätigung und Abbruch (BSD-283)", () => {
  it("bestätigt jede Datei erst nach dem Ablegen; Abbruch räumt auf, wenn alles Unterwegs angekommen ist", async () => {
    const fns = new Set<(e: { data: ImportWorkerEvent }) => void>();
    const got: unknown[] = [];
    const w: ImportWorkerLike & { terminated?: boolean } = {
      postMessage(m) {
        got.push(m);
        if ("files" in m) setTimeout(() => fns.forEach((fn) => fn({ data: { type: "asset", ack: true, asset: { id: "x1", name: "a.png", data: new Uint8Array(3) } } })));
      },
      addEventListener: (_t, fn) => fns.add(fn),
      terminate() { this.terminated = true; },
    };
    let release!: () => void;
    const stored = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const job = prepareInWorker([{ path: "a.md", data: new TextEncoder().encode("# A") }], () => undefined, () => w,
      async () => { await stored; order.push("stored"); }, async () => { order.push("abandon"); });
    await new Promise((r) => setTimeout(r, 5));
    expect(got.filter((m) => (m as { type?: string }).type === "ack")).toEqual([]); // noch nicht abgelegt
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(got).toContainEqual({ type: "ack", id: "x1" });
    job.cancel();
    await expect(job.result).rejects.toBeInstanceOf(ImportCancelledError);
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["stored", "abandon"]);
    expect(w.terminated).toBe(true);
  });
});

describe("Export", () => {
  it("Seite als Markdown und HTML, Workspace als ZIP", async () => {
    const { client } = setup();
    const { homePageID } = await client.init({});
    const md = await client.exportPage(homePageID!, "markdown");
    expect(md.name).toBe("Welcome to Based.md");
    const text = new TextDecoder().decode(md.data);
    expect(text).toMatch(/^# Welcome to Based/);
    expect(text).toContain("- [ ] Create a page");
    const html = await client.exportPage(homePageID!, "html");
    expect(html.mime).toMatch(/^text\/html/);
    expect(new TextDecoder().decode(html.data)).toContain("<h1 class=\"title\">Welcome to Based</h1>");

    await client.command({ op: "createPage", parent: homePageID!, title: "Child" });
    const zip = await client.exportWorkspace("markdown");
    const paths = readZipEntries(zip.data).map((e) => e.path).sort();
    expect(paths).toEqual(["Welcome to Based.md", "Welcome to Based/Child.md"]);
    const entry = readZipEntries(zip.data).find((e) => e.path === "Welcome to Based.md")!;
    expect(new TextDecoder().decode(zipEntryData(zip.data, entry))).toContain("Child");
    const site = await client.exportWorkspace("html");
    expect(readZipEntries(site.data).map((e) => e.path)).toContain("Welcome to Based/Child.html");
  });
});
