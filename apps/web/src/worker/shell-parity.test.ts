// Shell-Parität im Worker: Import mit Anhängen (Notion-HTML-ZIP, Markdown-ZIP/-Ordner, Größenlimit, fehlende Dateien),
// Export mit Dateien aus dem Asset-Speicher, Library, Seitengraph und Teamspace-Befehle über die Worker-Schnittstelle.
import { MemoryAssetSink, readZipEntries, writeZip, type Block, type GraphNode, type LibraryItem } from "@based/core";
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { afterEach, describe, expect, it } from "vitest";
import { assetURLResolver, MemoryAssetStore } from "./assets.js";
import { StoreClient } from "./client.js";
import { StoreHost } from "./host.js";
import { prepareFiles } from "./importer.js";
import type { Endpoint, Event, RequestMessage } from "./protocol.js";

type Fn<T> = (e: { data: T }) => void;
let hosts: StoreHost[] = [];
afterEach(() => {
  hosts.forEach((h) => h.stop());
  hosts = [];
});

function setup() {
  const toHost = new Set<Fn<RequestMessage>>();
  const toClient = new Set<Fn<Event>>();
  const end: Endpoint<Event, RequestMessage> = {
    postMessage: (m) => setTimeout(() => toHost.forEach((f) => f({ data: structuredClone(m) }))),
    addEventListener: (_t, f) => toClient.add(f),
    removeEventListener: (_t, f) => toClient.delete(f),
  };
  const assets = new MemoryAssetStore();
  const host = new StoreHost({
    post: (e) => { const c = structuredClone(e); setTimeout(() => toClient.forEach((f) => f({ data: c }))); },
    open: async ({ device }) => ({ ...openWorkspace(openNodeDatabase(":memory:"), { device }), persistent: true }),
    defer: (fn) => setTimeout(fn, 0),
    importedAssets: assets,
  });
  hosts.push(host);
  let queue = Promise.resolve();
  toHost.add((e) => { queue = queue.then(() => host.handle(e.data)); });
  return { host, client: new StoreClient(end), assets };
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const enc = new TextEncoder();
const dec = new TextDecoder();
/** 1×1-PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

const NOTION_PAGE = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>Trip</title></head><body>
<article id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" class="page sans"><header><h1 class="page-title">Trip</h1></header><div class="page-body">
<p id="b0000000-0000-4000-8000-000000000001" class="">Route for day one</p>
<figure id="b0000000-0000-4000-8000-000000000002" class="image"><a href="Trip%20aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa/map.png"><img style="width:240px" src="Trip%20aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa/map.png"/></a><figcaption>The map</figcaption></figure>
<figure id="b0000000-0000-4000-8000-000000000003" class="image"><a href="Trip%20aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa/gone.png"><img src="Trip%20aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa/gone.png"/></a></figure>
<figure id="b0000000-0000-4000-8000-000000000004"><div class="source"><a href="Trip%20aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa/huge.bin">huge.bin</a></div></figure>
<figure id="b0000000-0000-4000-8000-000000000005"><div class="source"><a href="Trip%20aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa/ticket.pdf">ticket.pdf</a></div></figure>
</div></article></body></html>`;

/** Notion-HTML-Export als ZIP: eine Seite, ein Bild, ein PDF, eine zu große Datei; `gone.png` fehlt. */
function notionZip(): Uint8Array {
  const dir = "Trip aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
  return writeZip([
    { path: `${dir}.html`, data: enc.encode(NOTION_PAGE) },
    { path: `${dir}/map.png`, data: PNG },
    { path: `${dir}/ticket.pdf`, data: enc.encode("%PDF-1.4 ticket") },
    { path: `${dir}/huge.bin`, data: new Uint8Array(5000) },
  ]);
}

async function importWith(files: { path: string; data: Uint8Array }[], maxAssetBytes = 4096) {
  const sink = new MemoryAssetSink();
  const payload = structuredClone(prepareFiles(files, { assets: sink, maxAssetBytes }));
  const x = setup();
  await x.client.init({});
  // BSD-230: die Dateien reisen mit dem Ergebnis; der Store-Worker legt sie über den Sync ab (SHA-256).
  const summary = await x.client.commitImport(payload);
  await settle();
  const blocks = [...x.host.ws!.store.blocks.values()];
  const get = async (id: string) => { const r = await x.client.assetGet(id); return r.ok ? new Uint8Array(r.bytes) : undefined; };
  return { ...x, sink, payload, summary, blocks, get };
}

const ofType = (blocks: Block[], type: string) => blocks.filter((b) => b.type === type);

describe("Import mit Anhängen", () => {
  it("Notion-HTML-ZIP: Bild und PDF landen im Asset-Speicher, Blöcke zeigen darauf; Limit und Fehlendes als Warnung", async () => {
    const r = await importWith([{ path: "Export.zip", data: notionZip() }]);
    expect(r.summary.pages).toBe(1);
    expect(r.summary.assets).toBe(2);
    const images = ofType(r.blocks, "image");
    const withAsset = images.find((b) => b.props?.asset);
    expect(withAsset?.props?.asset).toMatchObject({ name: "map.png", size: PNG.length, mime: "image/png" });
    expect(withAsset?.props?.url).toBeUndefined();
    expect(withAsset!.props!.asset!.id).toMatch(/^[0-9a-f]{64}$/);
    expect([...(await r.get(withAsset!.props!.asset!.id))!]).toEqual([...PNG]);
    const pdf = r.blocks.find((b) => b.props?.asset?.name === "ticket.pdf");
    expect(pdf?.type).toBe("pdf");
    expect(dec.decode((await r.get(pdf!.props!.asset!.id))!)).toBe("%PDF-1.4 ticket");
    // zu groß: kein Asset, aber eine klare Meldung; fehlend: gemeldet
    expect(r.blocks.some((b) => b.props?.asset?.name === "huge.bin")).toBe(false);
    const warnings = r.summary.warnings.join("\n");
    expect(warnings).toMatch(/Skipped “huge\.bin” \(4\.9 KB\): larger than the 4\.0 KB limit/);
    expect(warnings).toMatch(/Missing file “.*gone\.png”/);
    expect(warnings).not.toContain("not imported");
    expect(r.sink.files.size).toBe(2);
    // kein Platzhalter bleibt in den Records
    expect(JSON.stringify(r.blocks)).not.toContain("pending-");
  });

  it("Markdown-ZIP und Markdown-Ordner: Bilder mit relativem Pfad werden Assets", async () => {
    const md = "# Hike\n\nUp the hill\n\n![Summit](images/summit.png)\n\n![Lost](images/lost.png)\n\n![Remote](https://example.com/x.png)\n";
    const zip = writeZip([{ path: "Notes/Hike.md", data: enc.encode(md) }, { path: "Notes/images/summit.png", data: PNG }]);
    for (const files of [
      [{ path: "notes.zip", data: zip }],
      [{ path: "Notes/Hike.md", data: enc.encode(md) }, { path: "Notes/images/summit.png", data: PNG }],
    ]) {
      const r = await importWith(files);
      const images = ofType(r.blocks, "image");
      expect(images.length).toBe(3);
      const local = images.find((b) => b.props?.asset);
      expect(local?.props?.asset).toMatchObject({ name: "summit.png", mime: "image/png" });
      expect([...(await r.get(local!.props!.asset!.id))!]).toEqual([...PNG]);
      expect(images.filter((b) => b.props?.url === "https://example.com/x.png").length).toBe(1);
      expect(r.summary.assets).toBe(1);
      expect(r.summary.warnings.join("\n")).toMatch(/Missing file “.*images\/lost\.png”/);
    }
  });

  it("ohne Asset-Speicher bleibt es beim Hinweis (Bilder entfallen)", () => {
    const payload = prepareFiles([{ path: "Export.zip", data: notionZip() }]);
    expect(payload.assets).toBe(0);
    expect(payload.notion?.notes.join("\n") ?? "").toContain("not imported — file storage isn't available");
  });

  it("Export nimmt die Dateien aus dem Asset-Speicher: HTML bettet das Bild ein, ZIP legt es nach assets/", async () => {
    const r = await importWith([{ path: "Export.zip", data: notionZip() }]);
    const pageID = r.summary.rootIDs[0]!;
    // nur das Bild: eine Datei; mit PDF auf der Seite wird es ein ZIP mit assets/
    const withPdf = await r.client.exportPage(pageID, "html", { css: "body{color:var(--ink)}" });
    expect(withPdf.mime).toBe("application/zip");
    const paths = readZipEntries(withPdf.data).map((e) => e.path).sort();
    expect(paths).toEqual(["Trip.html", "assets/ticket.pdf"]);
    const folder = await r.client.exportPage(pageID, "html", { images: "folder" });
    expect(readZipEntries(folder.data).map((e) => e.path).sort()).toEqual(["Trip.html", "assets/map.png", "assets/ticket.pdf"]);
    const site = await r.client.exportWorkspace("html");
    expect(readZipEntries(site.data).map((e) => e.path)).toEqual(expect.arrayContaining(["Trip.html", "assets/map.png", "assets/ticket.pdf"]));
    expect(site.summary).not.toContain("missing");
    const print = await r.client.printPage(pageID, "body{color:var(--ink)}");
    expect(print.title).toBe("Trip");
    expect(print.html).toContain("data:image/png;base64,iVBOR");
    expect(print.html).toContain("Route for day one");
    expect(print.html).toContain("@page");
    expect(print.html).toContain("body{color:var(--ink)}");
    expect(print.missing).toBe(0);
    const archive = await r.client.exportWorkspace("archive");
    expect(readZipEntries(archive.data).filter((e) => e.path.startsWith("assets/")).length).toBe(2);
  });

  it("Based-Archiv mit Dateien: Dateien kommen in den Sync-Speicher, Verweise bleiben gültig", async () => {
    const a = await importWith([{ path: "Export.zip", data: notionZip() }]);
    const archive = await a.client.exportWorkspace("archive");
    const sink = new MemoryAssetSink();
    const payload = prepareFiles([{ path: archive.name, data: archive.data }], { assets: sink });
    expect(payload.assets).toBe(2);
    expect(payload.notes.join("\n")).not.toContain("not imported");
    const img = a.blocks.find((b) => b.props?.asset?.name === "map.png")!;
    expect([...sink.files.get(img.props!.asset!.id)!.data]).toEqual([...PNG]);
    // in ein zweites Gerät importieren: gleicher Inhalt = gleicher Hash
    const b = setup();
    await b.client.init({});
    await b.client.commitImport(structuredClone(payload));
    const got = await b.client.assetGet(img.props!.asset!.id);
    expect(got.ok && [...new Uint8Array(got.bytes)]).toEqual([...PNG]);
  });

  it("based-asset:-URLs werden einmal je Datei zu Blob-URLs; Fehlendes schlägt fehl", async () => {
    const store = new MemoryAssetStore();
    await store.put("a1", { data: PNG, name: "p.png", mime: "image/png" });
    const made: Blob[] = [];
    const resolve = assetURLResolver(store, (b) => { made.push(b); return "blob:test/" + made.length; });
    expect(await resolve("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(await resolve("based-asset:a1")).toBe("blob:test/1");
    expect(await resolve("based-asset:a1")).toBe("blob:test/1");
    expect(made.length).toBe(1);
    expect(made[0]!.type).toBe("image/png");
    await expect(resolve("based-asset:nope")).rejects.toThrow();
  });
});

describe("Library, Graph und Teamspaces über den Worker", () => {
  it("Teamspace anlegen, Seite verschieben, umbenennen, Icon, löschen", async () => {
    const { client } = setup();
    const { homePageID } = await client.init({});
    const t = await client.command<string>({ op: "createTeamspace", name: "Design", icon: "🎨" });
    await client.command({ op: "moveToSection", ids: [homePageID!], section: t });
    await settle();
    let o = client.getState().outline!;
    expect(o.sections).toEqual([{ id: t, name: "Design", icon: "🎨" }, { id: "private", name: "Private" }]);
    expect(o.children["section:" + t]).toEqual([homePageID]);
    expect(o.nodes[homePageID!]?.section).toBe(t);
    await client.command({ op: "renameTeamspace", id: t, name: "Studio" });
    await client.command({ op: "setTeamspaceIcon", id: t });
    await settle();
    expect(client.getState().outline!.sections[0]).toEqual({ id: t, name: "Studio" });
    await client.command({ op: "deleteTeamspace", id: t });
    await settle();
    o = client.getState().outline!;
    expect(o.sections).toEqual([{ id: "private", name: "Private" }]);
    expect(o.children["section:private"]).toEqual([homePageID]);
  });

  it("Library-Einträge, Duplizieren, in eine Seite verschieben", async () => {
    const { client } = setup();
    const { homePageID } = await client.init({});
    const a = await client.command<string>({ op: "createPage", title: "Alpha" });
    const [copy] = await client.command<string[]>({ op: "duplicate", ids: [a] });
    await client.command({ op: "moveInto", ids: [copy!], parent: homePageID! });
    await client.command({ op: "favorite", ids: [a], on: true });
    const items = await client.library();
    const by = new Map<string, LibraryItem>(items.map((i) => [i.id, i]));
    expect(by.get(a)).toMatchObject({ title: "Alpha", kind: "page", location: "Private", favorite: true });
    expect(by.get(copy!)).toMatchObject({ title: "Alpha (1)", location: "Welcome to Based", parentID: homePageID });
    expect(items.length).toBe(3);
  });

  it("Graph kommt zugeschnitten aus dem Worker und folgt Änderungen", async () => {
    const { client, host } = setup();
    const { homePageID } = await client.init({});
    const child = await client.command<string>({ op: "createPage", parent: homePageID!, title: "Child" });
    await client.command({ op: "createPage", title: "Lonely" });
    const all = await client.graph();
    expect(all.totalNodes).toBe(3);
    expect(all.graph.edges).toEqual([{ s: homePageID, t: child, k: "child" }]);
    const connected = await client.graph({ connectedOnly: true });
    expect(connected.graph.nodes.map((n: GraphNode) => n.title).sort()).toEqual(["Child", "Welcome to Based"]);
    expect(connected.totalNodes).toBe(3);
    const cached = host.graph();
    expect(host.graph().graph.nodes).toEqual(cached.graph.nodes);
    await client.command({ op: "trash", ids: [child] });
    expect((await client.graph({ connectedOnly: true })).graph.nodes).toEqual([]);
  });
});
