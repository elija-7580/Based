// ADR 0017 A2: größere Pull-Seiten mit Byte-Grenze, gzip für Push und Antworten – und unveränderte Antworten für
// Clients, die nichts davon nutzen.
import { gunzipSync, gzipSync } from "node:zlib";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceStore as PinnedStore, type WireRecord } from "@based/core";
import { SqlitePersistence, SyncClient } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { auth, get, post, startApp, TOKEN } from "./helpers.js";

PinnedStore.propertyRecordsByDefault = false;

const page = (i: number, text = "x".repeat(900)): WireRecord => ({
  kind: "block",
  data: { id: "p" + String(i).padStart(4, "0"), type: "page", parent: "w", sk: "a" + String(i).padStart(4, "0"), text, createdAt: 0, updatedAt: 0, stamp: { millis: 1000 + i, counter: 0, node: "dev" } },
});

let apps: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});
const start = async () => {
  const app = await startApp();
  apps.push(app);
  return app;
};

/** Rohe Anfrage ohne die automatische Entpackung von fetch. */
function raw(url: string, opts: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: opts.method ?? "GET", headers: { ...auth, ...(opts.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("Sync v2: Seiten nach Größe und gzip (ADR 0017 A2)", () => {
  it("info kündigt die Fähigkeiten an", async () => {
    const app = await start();
    expect((await get(`${app.url}/sync/v2/info`)).body).toMatchObject({ sync: { maxPage: 5000, pageBytes: true, gzip: true } });
  });

  it("Pull mit bytes: Seiten enden an der Grenze, zusammen kommt alles genau einmal an", async () => {
    const app = await start();
    const records = Array.from({ length: 60 }, (_, i) => page(i));
    expect((await post(`${app.url}/sync/v2/push`, { records, deletions: [] })).status).toBe(200);
    const seen: string[] = [];
    let after = 0, pages = 0;
    for (;;) {
      const r = (await get(`${app.url}/sync/v2/pull?after=${after}&limit=5000&bytes=10000`)).body as { records: WireRecord[]; next: number; more: boolean };
      pages += 1;
      expect(r.records.length).toBeGreaterThan(0);
      expect(r.records.length).toBeLessThan(20); // ~1 KB je Record, Grenze 10 KB
      for (const rec of r.records) seen.push(rec.data.id);
      after = r.next;
      if (!r.more) break;
    }
    expect(pages).toBeGreaterThan(4);
    expect(seen).toEqual(records.map((r) => r.data.id));
    // ein einzelner Record über der Grenze kommt trotzdem (der Cursor bleibt nie stehen)
    const one = (await get(`${app.url}/sync/v2/pull?after=0&limit=5000&bytes=1`)).body as { records: WireRecord[]; more: boolean };
    expect(one.records).toHaveLength(1);
    expect(one.more).toBe(true);
    // ohne bytes wie bisher: nur limit zählt
    const old = (await get(`${app.url}/sync/v2/pull?after=0&limit=500`)).body as { records: WireRecord[]; more: boolean };
    expect(old.records).toHaveLength(60);
    expect(old.more).toBe(false);
  });

  it("Antworten: gzip nur auf Wunsch und nur ab 1 KB; ohne Accept-Encoding byte-gleich wie bisher", async () => {
    const app = await start();
    await post(`${app.url}/sync/v2/push`, { records: Array.from({ length: 30 }, (_, i) => page(i)), deletions: [] });
    const plain = await raw(`${app.url}/sync/v2/pull?after=0&limit=500`);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    const packed = await raw(`${app.url}/sync/v2/pull?after=0&limit=500`, { headers: { "Accept-Encoding": "gzip" } });
    expect(packed.headers["content-encoding"]).toBe("gzip");
    expect(String(packed.headers.vary)).toMatch(/Accept-Encoding/i);
    expect(packed.body.length).toBeLessThan(plain.body.length / 5);
    expect(gunzipSync(packed.body).equals(plain.body)).toBe(true);
    // mit CORS bleibt „Origin“ in Vary stehen
    const cors = await startApp({ allowedOrigin: "https://based.example" });
    apps.push(cors);
    await post(`${cors.url}/sync/v2/push`, { records: Array.from({ length: 30 }, (_, i) => page(i)), deletions: [] });
    const both = await raw(`${cors.url}/sync/v2/pull?after=0`, { headers: { "Accept-Encoding": "gzip", Origin: "https://based.example" } });
    expect(String(both.headers.vary)).toMatch(/Origin.*Accept-Encoding/i);
    const small = await raw(`${app.url}/sync/v2/info`, { headers: { "Accept-Encoding": "gzip" } });
    expect(small.headers["content-encoding"]).toBeUndefined();
  });

  it("Push: gzip-Körper wird angenommen; kaputtes gzip 400, fremde Kodierung 415, entpackt zu groß 413", async () => {
    const app = await start();
    const body = Buffer.from(JSON.stringify({ records: [page(1), page(2)], deletions: [] }));
    const ok = await raw(`${app.url}/sync/v2/push`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: gzipSync(body) });
    expect(ok.status).toBe(200);
    expect(((await get(`${app.url}/sync/v2/pull?after=0`)).body as { records: unknown[] }).records).toHaveLength(2);
    expect((await raw(`${app.url}/sync/v2/push`, { method: "POST", headers: { "Content-Encoding": "gzip" }, body: Buffer.from("kein gzip") })).status).toBe(400);
    expect((await raw(`${app.url}/sync/v2/push`, { method: "POST", headers: { "Content-Encoding": "br" }, body })).status).toBe(415);
    const bomb = gzipSync(Buffer.alloc(40 << 20, 32)); // 40 MiB Leerzeichen, wenige KB komprimiert
    expect((await raw(`${app.url}/sync/v2/push`, { method: "POST", headers: { "Content-Encoding": "gzip" }, body: bomb })).status).toBe(413);
  });

  it("SyncClient gegen den echten Server: holt 12 000 Records in wenigen Seiten, pusht komprimiert, nichts fehlt", async () => {
    const app = await start();
    const all = Array.from({ length: 12_000 }, (_, i) => page(i, "note " + i));
    for (let i = 0; i < all.length; i += 4000) expect((await post(`${app.url}/sync/v2/push`, { records: all.slice(i, i + 4000), deletions: [] })).status).toBe(200);
    const persistence = new SqlitePersistence(openNodeDatabase());
    const store = new PinnedStore({ persistence, node: "client" });
    const calls: { url: string; encoding: string | null }[] = [];
    const client = new SyncClient(store, persistence, {
      baseURL: app.url, token: TOKEN,
      fetch: (input, init) => { calls.push({ url: String(input), encoding: new Headers(init?.headers).get("content-encoding") }); return fetch(input, init); },
    });
    const r = await client.syncOnce();
    expect(r.received).toBe(12_000);
    expect(store.blocks.size).toBe(12_000);
    const pulls = calls.filter((c) => c.url.includes("/sync/v2/pull"));
    expect(pulls.length).toBeLessThanOrEqual(4); // vorher 24 Seiten zu 500
    expect(pulls[0]!.url).toMatch(/limit=5000&bytes=2097152/);
    // lokale Änderung: der Push geht komprimiert
    store.transact("edit", (tx) => { for (let i = 0; i < 40; i++) tx.update("p" + String(i).padStart(4, "0"), (b) => { b.text = "changed ".repeat(20) + i; }); });
    calls.length = 0;
    const r2 = await client.syncOnce();
    expect(r2.pushed).toBe(40);
    expect(calls.find((c) => c.url.endsWith("/sync/v2/push"))?.encoding).toBe("gzip");
    const back = (await get(`${app.url}/sync/v2/pull?after=12000&limit=500`)).body as { records: WireRecord[] };
    expect(back.records).toHaveLength(40);
    expect(String(back.records[0]!.data.text)).toMatch(/^changed /);
  });
});
