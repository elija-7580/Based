// BSD-78: Dateien über die Worker-Schnittstelle – zwei Store-Hosts (Geräte) an einem nachgebauten Sync-Server
// (nur die Asset-Routen und leere Sync-Antworten), dazu die Editor-Brücke (assetBridge.ts).
import { openWorkspace, sha256Hex } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { afterEach, describe, expect, it } from "vitest";
import { assetNotice, assetsLabel, createAssetBridge } from "../assetBridge.js";
import { StoreClient } from "./client.js";
import { readFileSync } from "node:fs";
import { assetIDsInStore, makeBlock, MemoryAssetSink } from "@based/core";
import { MemoryAssetStore } from "./assets.js";
import { prepareFiles, type ImportFile } from "./importer.js";
import { StoreHost } from "./host.js";
import type { Endpoint, Event, RequestMessage, StatusInfo } from "./protocol.js";

/** Asset-Routen wie apps/server (dort gegen den echten Server getestet), hier nur so viel wie der Client braucht. */
function fakeServer() {
  const blobs = new Map<string, Uint8Array>();
  const partial = new Map<string, Uint8Array>();
  const state = { offline: false, puts: 0 };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher: typeof fetch = async (input, init) => {
    if (state.offline) throw new TypeError("Failed to fetch");
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const m = /^\/sync\/v2\/asset\/([0-9a-f]{64})(\/status)?$/.exec(url.pathname);
    if (url.pathname === "/sync/v2/info") return json({ protocol: 2, seq: 0, oldestSeq: 0, assets: { maxBytes: 1 << 20, chunkBytes: 1 << 20 } });
    if (url.pathname === "/sync/v2/pull") return json({ records: [], deletions: [], next: 0, more: false });
    if (url.pathname === "/sync/v2/push") return json({ newer: [], seq: 0, deleted: [] });
    if (url.pathname === "/sync/v2/wait") return new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    if (!m) return json({ error: "not found" }, 404);
    const hash = m[1]!;
    if (m[2]) {
      const done = blobs.get(hash);
      return json(done ? { complete: true, received: done.length, size: done.length } : { complete: false, received: partial.get(hash)?.length ?? 0 });
    }
    if (method === "PUT") {
      state.puts += 1;
      const offset = Number(url.searchParams.get("offset")), total = Number(url.searchParams.get("total"));
      const chunk = new Uint8Array(init!.body as Uint8Array);
      const have = offset === 0 ? new Uint8Array() : partial.get(hash) ?? new Uint8Array();
      if (have.length !== offset) return json({ error: "offset does not match", received: have.length }, 409);
      const next = new Uint8Array(have.length + chunk.length);
      next.set(have);
      next.set(chunk, have.length);
      if (next.length < total) {
        partial.set(hash, next);
        return json({ complete: false, received: next.length }, 202);
      }
      partial.delete(hash);
      blobs.set(hash, next);
      return json({ complete: true, received: total, size: total });
    }
    const blob = blobs.get(hash);
    if (!blob) return json({ error: "not found" }, 404);
    const r = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get("range") ?? "");
    return r ? new Response(blob.slice(Number(r[1]), Number(r[2]) + 1), { status: 206 }) : new Response(blob.slice(), { status: 200 });
  };
  return { fetcher, blobs, state };
}

type Fn<T> = (e: { data: T }) => void;
let hosts: StoreHost[] = [];
afterEach(() => {
  hosts.forEach((h) => h.stop());
  hosts = [];
});

function device(fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof StoreHost>[0]> = {}) {
  const toHost = new Set<Fn<RequestMessage>>();
  const toClient = new Set<Fn<Event>>();
  const statuses: StatusInfo[] = [];
  const endpoint: Endpoint<Event, RequestMessage> = {
    postMessage: (m) => setTimeout(() => toHost.forEach((f) => f({ data: structuredClone(m) }))),
    addEventListener: (_t, f) => toClient.add(f),
    removeEventListener: (_t, f) => toClient.delete(f),
  };
  const host = new StoreHost({
    post: (e) => {
      if (e.type === "status") statuses.push(e.status);
      const copy = structuredClone(e);
      setTimeout(() => toClient.forEach((f) => f({ data: copy })));
    },
    open: async ({ device: d }) => ({ ...openWorkspace(openNodeDatabase(), { device: d }), persistent: true }),
    fetch: fetcher,
    syncTiming: { intervalMs: 60_000, waitTimeoutSeconds: 1, pushDelayMs: 5 },
    assetTiming: { chunkSize: 400, backoff: { minMs: 20, maxMs: 40 } },
    ...extra,
  });
  hosts.push(host);
  let queue = Promise.resolve();
  toHost.add((e) => {
    queue = queue.then(() => host.handle(e.data));
  });
  return { host, client: new StoreClient(endpoint), statuses };
}

const sync = { url: "https://sync.example", token: "t" };
const png = (n: number) => {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < n; i++) b[i] = (i * 31) % 251;
  return b;
};

describe("Dateien über den Store-Worker", () => {
  it("Gerät A speichert und lädt hoch, Gerät B holt bei Bedarf; Status zeigt die Übertragung", async () => {
    const server = fakeServer();
    const a = device(server.fetcher), b = device(server.fetcher);
    await a.client.init({ sync });
    await b.client.init({ sync });
    const data = png(1000);
    const info = await a.client.assetPut("foto.png", data.slice().buffer, "image/png");
    expect(info).toEqual({ id: await sha256Hex(data), name: "foto.png", size: 1000, mime: "image/png" });
    // sofort lokal lesbar, auch ohne Server
    const local = await a.client.assetGet(info.id);
    expect(local.ok && new Uint8Array(local.bytes)).toEqual(data);
    await expect.poll(() => server.blobs.has(info.id)).toBe(true);
    expect(server.state.puts).toBe(3); // 400 + 400 + 200
    expect(a.statuses.some((s) => s.assets?.uploads === 1)).toBe(true);
    await expect.poll(() => a.host.status().assets).toBeUndefined();

    const got = await b.client.assetGet(info.id);
    expect(got.ok && new Uint8Array(got.bytes)).toEqual(data);
    expect(await b.host.assets!.hasLocal(info.id)).toBe(true);
    // unbekannte Datei bzw. Datei aus der Swift-App: Grund statt Ausnahme
    expect(await b.client.assetGet("f".repeat(64))).toMatchObject({ ok: false, code: "missing" });
    expect(await b.client.assetGet("0F2B6C1E-1111-4222-8333-444455556666")).toMatchObject({ ok: false, code: "not-addressable" });
  });

  it("offline hochgeladen: wartet in der Warteschlange (Status „paused“) und geht später von selbst raus", async () => {
    const server = fakeServer();
    server.state.offline = true;
    const a = device(server.fetcher);
    await a.client.init({ sync });
    const info = await a.client.assetPut("notiz.png", png(500).buffer);
    await expect.poll(() => a.host.status().assets).toMatchObject({ uploads: 1, paused: "offline" });
    expect(assetsLabel(a.host.status().assets)).toBe("1 file waiting to upload (offline)");
    server.state.offline = false;
    await expect.poll(() => server.blobs.has(info.id), { timeout: 3000 }).toBe(true);
    await expect.poll(() => a.host.status().assets).toBeUndefined();
  });

  it("ohne Server: Datei bleibt lokal und vorgemerkt; nach dem Verbinden wird sie hochgeladen", async () => {
    const server = fakeServer();
    const a = device(server.fetcher);
    await a.client.init({});
    const info = await a.client.assetPut("lokal.png", png(300).buffer);
    expect((await a.client.assetGet(info.id)).ok).toBe(true);
    expect(a.host.status().assets).toMatchObject({ uploads: 1 });
    expect(server.state.puts).toBe(0);
    await a.client.setSync(sync);
    await expect.poll(() => server.blobs.has(info.id)).toBe(true);
  });

  it("Editor-Brücke: Upload ergibt based-asset:<hash>; fehlende Datei bleibt Platzhalter und erscheint, sobald sie da ist", async () => {
    const server = fakeServer();
    const a = device(server.fetcher), b = device(server.fetcher);
    await a.client.init({});
    await b.client.init({ sync });
    const made: Blob[] = [];
    const createObjectURL = (blob: Blob) => `blob:test/${made.push(blob)}`;
    const data = png(700);
    const bridgeA = createAssetBridge(a.client, { createObjectURL });
    const url = await bridgeA.uploadFile(new File([data], "bild.png", { type: "image/png" }));
    expect(url).toBe(`based-asset:${await sha256Hex(data)}`);
    expect(await bridgeA.resolveFileUrl(url)).toBe("blob:test/1");
    expect(await bridgeA.resolveFileUrl("https://example.com/x.png")).toBe("https://example.com/x.png");

    // B kennt den Block schon, die Datei ist noch nicht auf dem Server (A hat keinen Server eingestellt).
    const notes: string[] = [];
    const removed: string[] = [];
    const el = {
      tagName: "IMG",
      setAttribute: (k: string, v: string) => void (k === "data-asset-state" && notes.push(v)),
      removeAttribute: (k: string) => void removed.push(k),
      getAttribute: () => url,
    } as unknown as Element;
    const bridgeB = createAssetBridge(b.client, { createObjectURL, retry: { minMs: 20, maxMs: 40 }, elements: () => [el] });
    let resolved: string | undefined;
    const p = bridgeB.resolveFileUrl(url).then((u) => (resolved = u));
    await expect.poll(() => notes.includes("missing")).toBe(true);
    expect(resolved).toBeUndefined();
    await a.client.setSync(sync);
    await p;
    expect(resolved).toBe("blob:test/2");
    expect(made[1]!.type).toBe("image/png");
    expect(new Uint8Array(await made[1]!.arrayBuffer())).toEqual(data);
    expect(notes[0]).toBe("loading");
    expect(removed).toContain("data-asset-state"); // Platzhalter weg, sobald das Bild da ist
    // Nicht übertragbare Datei: kein endloses Warten.
    await expect(bridgeB.resolveFileUrl("based-asset:0F2B6C1E-1111-4222-8333-444455556666")).rejects.toThrow(/only stored on the device/);
  });

  it("Texte der Anzeige", () => {
    expect(assetsLabel(undefined)).toBe("");
    expect(assetsLabel({ uploads: 2, downloads: 1, failed: 1 })).toBe("2 files uploading · 1 file downloading · 1 file too large for the server");
    expect(assetNotice("missing")).toMatch(/hasn't been uploaded yet/);
    expect(assetNotice("something-else")).toMatch(/can't be loaded/);
  });
});

// BSD-230: importierte Dateien gehen über den Sync (ein Speicher, ein Weg).
function notionExport(): ImportFile[] {
  const fx = JSON.parse(readFileSync(new URL("../../../../fixtures/import/notion-html.utc.json", import.meta.url), "utf8")) as { cases: { input: { files?: { path: string; text?: string; base64?: string }[] } }[] };
  return fx.cases[0]!.input.files!.map((f) => ({ path: "Export/" + f.path, data: f.base64 !== undefined ? Uint8Array.from(Buffer.from(f.base64, "base64")) : new TextEncoder().encode(f.text ?? "") }));
}
const isHash = (id: string) => /^[0-9a-f]{64}$/.test(id);

describe("Dateien aus Importen (BSD-230)", () => {
  it("Import legt Dateien inhaltsadressiert ab und lädt sie hoch; Gerät B sieht das Bild", async () => {
    const server = fakeServer();
    const a = device(server.fetcher, { migrateDelayMs: 60_000 }), b = device(server.fetcher, { migrateDelayMs: 60_000 });
    await a.client.init({ sync });
    await b.client.init({ sync });
    const payload = prepareFiles(notionExport(), { assets: new MemoryAssetSink() });
    expect(payload.files?.length).toBeGreaterThan(0);
    const summary = await a.client.commitImport(structuredClone(payload));
    expect(summary.warnings.filter((w) => w.includes("couldn't be saved"))).toEqual([]);
    const ids = [...assetIDsInStore(a.host.ws!.store)];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every(isHash)).toBe(true);
    await expect.poll(() => ids.every((id) => server.blobs.has(id))).toBe(true);
    const got = await b.client.assetGet(ids[0]!);
    expect(got.ok).toBe(true);
  });

  it("Migration: alte Import-Dateien aus IndexedDB wandern in den Sync, Verweise werden umgeschrieben", async () => {
    const server = fakeServer();
    const imported = new MemoryAssetStore();
    const data = png(300);
    await imported.put("old-uuid-1", { data, name: "foto.png", mime: "image/png" });
    const a = device(server.fetcher, { importedAssets: imported, migrateDelayMs: 60_000 });
    const { homePageID } = await a.client.init({ sync });
    const store = a.host.ws!.store;
    store.transact("add", (tx) => {
      tx.put({ kind: "block", data: makeBlock({ id: "img-1", type: "image", parent: "b:" + homePageID, sk: "zz", props: { asset: { id: "old-uuid-1", name: "foto.png", size: 300, mime: "image/png" } } }, store.now()) });
      tx.put({ kind: "block", data: makeBlock({ id: "gone-1", type: "image", parent: "b:" + homePageID, sk: "zzz", props: { asset: { id: "missing-uuid", name: "x.png" } } }, store.now()) });
    });
    expect(await a.host.migrateImportedAssets()).toBe(1);
    const hash = await sha256Hex(data);
    expect(store.blocks.get("img-1")!.props!.asset!.id).toBe(hash);
    expect(store.blocks.get("gone-1")!.props!.asset!.id).toBe("missing-uuid");
    expect(await imported.has("old-uuid-1")).toBe(false);
    const got = await a.client.assetGet(hash);
    expect(got.ok && new Uint8Array(got.bytes)).toEqual(data);
    await expect.poll(() => server.blobs.has(hash)).toBe(true);
    expect(await a.host.migrateImportedAssets()).toBe(0);
  });
});
