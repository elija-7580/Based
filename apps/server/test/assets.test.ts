// BSD-78: Dateien über den Server-Sync. Zwei Geräte (`AssetSync` + `SyncClient` aus packages/sync) gegen den
// TS-Server im Prozess über echtes HTTP.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { WireRecord, WorkspaceStore } from "@based/core";
import { ASSET_QUEUE_KEY, AssetError, AssetSync, MemoryAssetBlobStore, openWorkspace, sha256Hex, SqlitePersistence, SyncClient, type AssetSyncOptions } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { createLogger } from "../src/log.js";
import { auth, get, startApp, TOKEN } from "./helpers.js";
import type { AppOptions } from "../src/app.js";

type Device = { store: WorkspaceStore; persistence: SqlitePersistence; blobs: MemoryAssetBlobStore };
const device = (): Device => ({ ...openWorkspace(openNodeDatabase()), blobs: new MemoryAssetBlobStore() });

/** Pseudozufällige, reproduzierbare Bytes. */
function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed * 2654435761;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}
const hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const imageBlock = (id: string, asset: { id: string; name: string; size: number; mime?: string }): WireRecord => ({
  kind: "block",
  data: { id, type: "image", parent: "b:page", sk: "a0", props: { asset }, createdAt: 0, updatedAt: 0, stamp: { millis: 0, counter: 0, node: "" } },
});
const page: WireRecord = {
  kind: "block",
  data: { id: "page", type: "page", parent: "w", sk: "a0", text: "Fotos", createdAt: 0, updatedAt: 0, stamp: { millis: 0, counter: 0, node: "" } },
};

let apps: { close(): Promise<void> }[] = [];
let syncs: AssetSync[] = [];
afterEach(async () => {
  for (const s of syncs) s.stop();
  syncs = [];
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function setup(opts: Partial<AppOptions> = {}) {
  const app = await startApp(opts);
  apps.push(app);
  const assets = (d: Device, o: AssetSyncOptions = {}) => {
    const s = new AssetSync(d.blobs, d.persistence, { server: { baseURL: app.url, token: TOKEN }, chunkSize: 1000, backoff: { minMs: 20, maxMs: 80 }, ...o });
    syncs.push(s);
    return s;
  };
  const client = (d: Device, a?: AssetSync) =>
    new SyncClient(d.store, d.persistence, { baseURL: app.url, token: TOKEN, ...(a ? { beforePush: () => a.flush() } : {}) });
  return { app, assets, client };
}

describe("Assets über den Server-Sync", () => {
  it("Bild auf A → auf B sichtbar, Bytes identisch; gleiche Bytes werden nur einmal gespeichert", async () => {
    const { app, assets, client } = await setup();
    const a = device(), b = device();
    const aa = assets(a), ab = assets(b);
    const data = bytes(3500);

    const ref = await aa.add(data, "foto.png", "image/png");
    expect(ref).toEqual({ id: hex(data), name: "foto.png", size: 3500, mime: "image/png" });
    a.store.transact("Insert image", (tx) => {
      tx.put(page);
      tx.put(imageBlock("img", ref));
    });
    // Eine Runde: erst die Datei, dann die Records.
    await client(a, aa).syncOnce();
    expect(aa.status().pending).toBe(0);
    expect(app.assets.list()).toEqual([ref.id]);

    await client(b, ab).syncOnce();
    const seen = b.store.blocks.get("img")?.props?.asset;
    expect(seen).toEqual(ref);
    expect(await ab.hasLocal(ref.id)).toBe(false); // erst bei Bedarf
    const progress: number[] = [];
    const got = await ab.get(seen!.id, (n) => progress.push(n));
    expect(Buffer.from(got).equals(Buffer.from(data))).toBe(true);
    expect(progress).toEqual([1000, 2000, 3000, 3500]);
    expect(await ab.hasLocal(ref.id)).toBe(true);

    // Dieselben Bytes noch einmal (anderer Name, anderes Gerät): gleiche ID, kein zweiter Upload.
    const puts: string[] = [];
    const counting: typeof fetch = (input, init) => {
      if (init?.method === "PUT") puts.push(String(input));
      return fetch(input, init);
    };
    const ab2 = assets(b, { fetch: counting });
    const again = await ab2.add(data, "kopie.png");
    expect(again.id).toBe(ref.id);
    await ab2.flush();
    expect(puts).toEqual([]);
    expect(ab2.status().pending).toBe(0);
    expect(app.assets.list()).toEqual([ref.id]);
  });

  it("Abbruch mitten im Upload → nach Neustart geht es beim Stand des Servers weiter", async () => {
    const { app, assets } = await setup();
    const a = device();
    const data = bytes(5300, 7);
    const hash = hex(data);
    let puts = 0;
    const flaky: typeof fetch = (input, init) => {
      if (init?.method === "PUT" && ++puts >= 3) return Promise.reject(new TypeError("connection lost"));
      return fetch(input, init);
    };
    const first = assets(a, { fetch: flaky, backoff: { minMs: 60_000, maxMs: 60_000 } });
    await first.add(data, "video.mov");
    await first.flush();
    expect(first.status()).toMatchObject({ pending: 1, lastError: "offline" });
    expect(app.assets.status(hash)).toEqual({ complete: false, received: 2000 });
    first.stop();

    // „Neustart“: neue Instanz, Warteschlange aus der Datenbank.
    expect(JSON.parse(a.persistence.meta(ASSET_QUEUE_KEY)!)).toEqual([{ hash, size: 5300 }]);
    const offsets: string[] = [];
    const recording: typeof fetch = (input, init) => {
      if (init?.method === "PUT") offsets.push(new URL(String(input)).searchParams.get("offset")!);
      return fetch(input, init);
    };
    const second = assets(a, { fetch: recording });
    await second.flush();
    expect(offsets).toEqual(["2000", "3000", "4000", "5000"]);
    expect(second.status()).toMatchObject({ pending: 0, failed: 0 });
    expect(a.persistence.meta(ASSET_QUEUE_KEY)).toBeUndefined();
    expect(app.assets.status(hash)).toEqual({ complete: true, received: 5300, size: 5300 });
    const r = await fetch(`${app.url}/sync/v2/asset/${hash}`, { headers: auth });
    expect(Buffer.from(await r.arrayBuffer()).equals(Buffer.from(data))).toBe(true);
  });

  it("offline: bleibt in der Warteschlange und wird mit wachsendem Abstand erneut versucht", async () => {
    const { app, assets } = await setup();
    const a = device();
    let offline = true;
    let attempts = 0;
    const net: typeof fetch = (input, init) => {
      attempts += 1;
      return offline ? Promise.reject(new TypeError("offline")) : fetch(input, init);
    };
    const aa = assets(a, { fetch: net });
    const ref = await aa.add(bytes(1500, 3), "notiz.txt");
    await aa.flush();
    expect(aa.status()).toMatchObject({ pending: 1, lastError: "offline" });
    await new Promise((r) => setTimeout(r, 150));
    expect(attempts).toBeGreaterThan(1); // erneute Versuche ohne Zutun
    expect(aa.status().pending).toBe(1);
    offline = false;
    await expect.poll(() => aa.status().pending, { timeout: 2000 }).toBe(0);
    expect(app.assets.list()).toEqual([ref.id]);
    expect(aa.status().lastError).toBeUndefined();
  });

  it("zu große Datei: sauberer Fehler, kein endloses Wiederholen, andere Dateien laufen weiter", async () => {
    const { app, assets } = await setup({ maxAssetBytes: 2000 });
    const a = device();
    const aa = assets(a);
    const big = await aa.add(bytes(2001, 5), "gross.bin");
    const small = await aa.add(bytes(900, 6), "klein.bin");
    await aa.flush();
    expect(aa.status()).toMatchObject({ pending: 0, failed: 1 });
    expect(aa.queued).toEqual([{ hash: big.id, size: 2001, failed: "too-large" }]);
    expect(app.assets.list()).toEqual([small.id]);

    // Der Server selbst lehnt ab, auch wenn ein Client die Grenze nicht beachtet (Stück für Stück oder am Stück).
    const put = (path: string, body: Uint8Array) => fetch(`${app.url}${path}`, { method: "PUT", headers: auth, body: body as Uint8Array<ArrayBuffer> });
    const r1 = await put(`/sync/v2/asset/${big.id}?offset=0&total=2001`, bytes(2001, 5).subarray(0, 500));
    expect(r1.status).toBe(413);
    expect(await r1.json()).toEqual({ error: "asset too large", limit: 2000 });
    const r2 = await put(`/sync/v2/asset/${big.id}`, bytes(2001, 5));
    expect(r2.status).toBe(413);
    expect(app.assets.status(big.id)).toEqual({ complete: false, received: 0 });
    // Ein einzelnes Stück über der Body-Grenze der Route: 413 vom Router.
    const huge = new Uint8Array((8 << 20) + 1);
    const r3 = await put(`/sync/v2/asset/${hex(huge)}?offset=0&total=${huge.length}`, huge).catch(() => undefined);
    if (r3) expect(r3.status).toBe(413);
  });

  it("ohne Token 401 auf allen Asset-Routen, mit falschem Token auch", async () => {
    const { app, assets } = await setup();
    const data = bytes(100, 9);
    const hash = hex(data);
    const url = `${app.url}/sync/v2/asset/${hash}`;
    for (const headers of [{}, { Authorization: "Bearer falsch" }] as Record<string, string>[]) {
      expect((await fetch(url, { headers })).status).toBe(401);
      expect((await fetch(url, { method: "HEAD", headers })).status).toBe(401);
      expect((await fetch(`${url}/status`, { headers })).status).toBe(401);
      expect((await fetch(url, { method: "PUT", headers, body: data as Uint8Array<ArrayBuffer> })).status).toBe(401);
      expect((await fetch(`${url}?token=${TOKEN}`, { headers })).status).toBe(401);
    }
    expect(app.assets.status(hash)).toEqual({ complete: false, received: 0 });

    const a = device();
    const aa = assets(a, { server: { baseURL: app.url, token: "falsch" } });
    await aa.add(data, "x.bin");
    await aa.flush();
    expect(aa.status()).toMatchObject({ pending: 1, lastError: "unauthorized" });
    await expect(aa.get(hex(bytes(5, 99)))).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("Protokoll: Status, HEAD, Range, falscher Offset (409), falscher Inhalt (422), ungültige ID (400)", async () => {
    const { app } = await setup();
    const data = bytes(2500, 11);
    const hash = hex(data);
    const base = `${app.url}/sync/v2/asset/${hash}`;
    const put = (q: string, body: Uint8Array) => fetch(`${base}${q}`, { method: "PUT", headers: auth, body: body as Uint8Array<ArrayBuffer> });

    expect((await get(`${app.url}/sync/v2/info`)).body).toMatchObject({ assets: { maxBytes: 100 << 20, chunkBytes: 8 << 20 } });
    expect((await get(`${base}/status`)).body).toEqual({ complete: false, received: 0 });
    expect((await fetch(base, { method: "HEAD", headers: auth })).status).toBe(404);
    expect((await fetch(base, { headers: auth })).status).toBe(404);

    const p1 = await put("?offset=0&total=2500", data.subarray(0, 1000));
    expect(p1.status).toBe(202);
    expect(await p1.json()).toEqual({ complete: false, received: 1000 });
    const wrong = await put("?offset=1500&total=2500", data.subarray(1500));
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toEqual({ error: "offset does not match", received: 1000 });
    expect((await put("?offset=1000&total=1200", data.subarray(1000))).status).toBe(400);
    // Unfertige Dateien liefert der Server nicht aus.
    expect((await fetch(base, { headers: auth })).status).toBe(404);
    const p2 = await put("?offset=1000&total=2500", data.subarray(1000));
    expect(p2.status).toBe(200);
    expect(await p2.json()).toEqual({ complete: true, received: 2500, size: 2500 });
    // Idempotent: noch einmal hochladen ändert nichts.
    expect(await (await put("", data)).json()).toEqual({ complete: true, received: 2500, size: 2500 });

    const head = await fetch(base, { method: "HEAD", headers: auth });
    expect([head.status, head.headers.get("content-length")]).toEqual([200, "2500"]);
    const full = await fetch(base, { headers: auth });
    expect(full.headers.get("content-type")).toBe("application/octet-stream");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await sha256Hex(new Uint8Array(await full.arrayBuffer()))).toBe(hash);
    const part = await fetch(base, { headers: { ...auth, Range: "bytes=1000-1999" } });
    expect([part.status, part.headers.get("content-range")]).toEqual([206, "bytes 1000-1999/2500"]);
    expect(Buffer.from(await part.arrayBuffer()).equals(Buffer.from(data.subarray(1000, 2000)))).toBe(true);
    expect((await fetch(base, { headers: { ...auth, Range: "bytes=2500-" } })).status).toBe(416);

    // Inhalt passt nicht zum Hash: 422, nichts gespeichert.
    const other = hex(bytes(10, 12));
    const bad = await fetch(`${app.url}/sync/v2/asset/${other}`, { method: "PUT", headers: auth, body: bytes(10, 13) as Uint8Array<ArrayBuffer> });
    expect(bad.status).toBe(422);
    expect(app.assets.status(other)).toEqual({ complete: false, received: 0 });
    for (const id of ["abc", hash.toUpperCase(), `${hash.slice(0, 63)}g`, `${hash}0`]) {
      expect((await fetch(`${app.url}/sync/v2/asset/${id}/status`, { headers: auth })).status, id).toBe(400);
    }
    // CORS-Preflight erlaubt PUT und Range.
    const pre = await fetch(base, { method: "OPTIONS" });
    expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
    expect(pre.headers.get("access-control-allow-headers")).toContain("Range");
  });

  it("Download: Datei fehlt noch auf dem Server → „missing“; Abbruch → nächster Versuch setzt fort", async () => {
    const { assets, client } = await setup();
    const a = device(), b = device();
    const data = bytes(4200, 21);
    // A ist für Dateien offline, die Records kommen trotzdem an.
    const aOffline = assets(a, { fetch: () => Promise.reject(new TypeError("offline")), backoff: { minMs: 60_000, maxMs: 60_000 } });
    const ref = await aOffline.add(data, "skizze.png");
    a.store.transact("Insert image", (tx) => {
      tx.put(page);
      tx.put(imageBlock("img", ref));
    });
    await client(a, aOffline).syncOnce();
    await client(b).syncOnce();
    expect(b.store.blocks.get("img")?.props?.asset?.id).toBe(ref.id);
    await expect(assets(b).get(ref.id)).rejects.toMatchObject({ name: "AssetError", code: "missing" });
    aOffline.stop();

    const aOnline = assets(a);
    await aOnline.flush();
    let gets = 0;
    const ranges: string[] = [];
    const flaky: typeof fetch = (input, init) => {
      const range = new Headers(init?.headers).get("range");
      if (range) {
        ranges.push(range);
        if (++gets === 3) return Promise.reject(new TypeError("connection lost"));
      }
      return fetch(input, init);
    };
    const ab = assets(b, { fetch: flaky });
    await expect(ab.get(ref.id)).rejects.toBeInstanceOf(AssetError);
    expect(await ab.hasLocal(ref.id)).toBe(false);
    const got = await ab.get(ref.id);
    expect(Buffer.from(got).equals(Buffer.from(data))).toBe(true);
    expect(ranges).toEqual(["bytes=0-999", "bytes=1000-1999", "bytes=2000-2999", "bytes=2000-2999", "bytes=3000-3999", "bytes=4000-4199"]);
    // Dateien aus der Swift-App (UUID statt Hash) sind nicht über den Server übertragbar.
    await expect(ab.get("0F2B6C1E-1111-4222-8333-444455556666")).rejects.toMatchObject({ code: "not-addressable" });
  });

  it("Aufräumen: nicht referenzierte Dateien erst nach der Tombstone-Frist (90 Tage ohne Referenz)", async () => {
    const { app, assets, client } = await setup();
    const a = device();
    const aa = assets(a);
    const used = await aa.add(bytes(700, 31), "bleibt.png");
    const orphan = await aa.add(bytes(800, 32), "weg.png");
    a.store.transact("Insert", (tx) => {
      tx.put(page);
      tx.put(imageBlock("img1", used));
      tx.put(imageBlock("img2", orphan));
    });
    await client(a, aa).syncOnce();
    const day = 86_400_000;
    const t0 = 1_800_000_000_000;
    expect(app.collectAssets(t0)).toEqual({ removed: 0, marked: 0, partials: 0 });

    a.store.transact("Delete", (tx) => tx.remove("block:img2"));
    await client(a, aa).syncOnce();
    expect(app.collectAssets(t0 + day)).toMatchObject({ removed: 0, marked: 1 });
    expect(app.collectAssets(t0 + 90 * day)).toMatchObject({ removed: 0, marked: 1 }); // erst 89 Tage ohne Referenz
    expect(app.assets.list().sort()).toEqual([used.id, orphan.id].sort());

    // Wieder referenziert (z. B. aus dem Papierkorb zurück): die Frist beginnt später neu.
    a.store.transact("Insert", (tx) => tx.put(imageBlock("img3", orphan)));
    await client(a, aa).syncOnce();
    expect(app.collectAssets(t0 + 91 * day)).toMatchObject({ removed: 0, marked: 0 });
    a.store.transact("Delete", (tx) => tx.remove("block:img3"));
    await client(a, aa).syncOnce();
    expect(app.collectAssets(t0 + 100 * day)).toMatchObject({ removed: 0, marked: 1 });
    expect(app.collectAssets(t0 + 189 * day)).toMatchObject({ removed: 0, marked: 1 });
    expect(app.collectAssets(t0 + 190 * day)).toMatchObject({ removed: 1, marked: 0 });
    expect(app.assets.list()).toEqual([used.id]);

    // Angefangene Uploads ohne Fortschritt verfallen nach 7 Tagen.
    const part = bytes(3000, 33);
    await fetch(`${app.url}/sync/v2/asset/${hex(part)}?offset=0&total=3000`, { method: "PUT", headers: auth, body: part.subarray(0, 1000) as Uint8Array<ArrayBuffer> });
    expect(app.collectAssets(Date.now() + 6 * day).partials).toBe(0);
    expect(app.collectAssets(Date.now() + 8 * day).partials).toBe(1);
    expect(app.assets.status(hex(part))).toEqual({ complete: false, received: 0 });
  });

  it("Logs enthalten weder Dateinamen noch Hashes noch Tokens", async () => {
    const lines: string[] = [];
    const { app, assets } = await setup({ log: createLogger({ minimum: "debug", write: (l) => lines.push(l) }) });
    const a = device();
    const clientLog: string[] = [];
    const aa = assets(a, { log: (_l, m) => clientLog.push(m) });
    const ref = await aa.add(bytes(1200, 41), "Gehaltsliste-geheim.pdf");
    await aa.flush();
    await aa.get(ref.id);
    await fetch(`${app.url}/sync/v2/asset/${ref.id}`, { headers: auth });
    await fetch(`${app.url}/sync/v2/asset/${ref.id}/status`);
    await new Promise((r) => setTimeout(r, 20));
    const all = [...lines, ...clientLog].join("\n");
    expect(lines.some((l) => l.includes('"/sync/v2/asset/:hash"'))).toBe(true);
    expect(all).not.toContain("geheim");
    expect(all).not.toContain(ref.id);
    expect(all).not.toContain(ref.id.slice(0, 12));
    expect(all).not.toContain(TOKEN);
  });
});
