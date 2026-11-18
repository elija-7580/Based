// ADR 0017 A2: Ein Server, der nichts ankündigt (ältere TS-Server, Swift), bekommt genau die bisherigen Anfragen.
import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "@based/core";
import { gzipText, PULL_PAGE_BYTES, SqlitePersistence, syncCapabilities, SyncClient } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import { FakeServer } from "./fake-server.js";

describe("Sync-Fähigkeiten", () => {
  it("ohne Angaben: Seiten zu pageSize, kein bytes, kein gzip", () => {
    expect(syncCapabilities(undefined, 500, PULL_PAGE_BYTES)).toEqual({ pullLimit: 500, pullBytes: undefined, gzip: false });
    expect(syncCapabilities({ oldestSeq: 3 }, 500, PULL_PAGE_BYTES)).toEqual({ pullLimit: 500, pullBytes: undefined, gzip: false });
    expect(syncCapabilities({ sync: "ja" as never }, 500, PULL_PAGE_BYTES)).toEqual({ pullLimit: 500, pullBytes: undefined, gzip: false });
  });

  it("mit Angaben: größere Seiten nur zusammen mit der Byte-Grenze, höchstens 5000", () => {
    expect(syncCapabilities({ sync: { maxPage: 5000, pageBytes: true, gzip: true } }, 500, 1000)).toEqual({ pullLimit: 5000, pullBytes: 1000, gzip: true });
    expect(syncCapabilities({ sync: { maxPage: 100_000, pageBytes: true } }, 500, 1000)).toEqual({ pullLimit: 5000, pullBytes: 1000, gzip: false });
    expect(syncCapabilities({ sync: { maxPage: 5000, gzip: true } }, 500, 1000)).toEqual({ pullLimit: 500, pullBytes: undefined, gzip: true });
    expect(syncCapabilities({ sync: { maxPage: 100, pageBytes: true } }, 500, 1000).pullLimit).toBe(500);
  });

  it("gzipText ergibt gültiges gzip", async () => {
    const packed = await gzipText("hello ".repeat(500));
    expect(packed).toBeInstanceOf(Uint8Array);
    expect(packed!.length).toBeLessThan(200);
    const text = await new Response(new Blob([packed!]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    expect(text).toBe("hello ".repeat(500));
  });

  it("alter Server: unveränderte Anfragen (limit=500, kein bytes, kein Content-Encoding)", async () => {
    const server = new FakeServer();
    const seen: { url: string; encoding: string | null; body: unknown }[] = [];
    const persistence = new SqlitePersistence(openNodeDatabase());
    const store = new WorkspaceStore({ persistence, node: "client" });
    const client = new SyncClient(store, persistence, {
      baseURL: "http://server", token: server.token,
      fetch: (input, init) => { seen.push({ url: String(input), encoding: new Headers(init?.headers).get("content-encoding"), body: init?.body }); return server.fetch(input, init); },
    });
    store.transact("t", (tx) => { for (let i = 0; i < 30; i++) tx.put({ kind: "block", data: { id: "b" + i, type: "page", parent: "w", sk: "a" + i, text: "long text ".repeat(40), createdAt: 0, updatedAt: 0 } }); });
    await client.syncOnce();
    const push = seen.find((s) => s.url.endsWith("/sync/v2/push"))!;
    expect(push.encoding).toBeNull();
    expect(typeof push.body).toBe("string");
    expect(seen.filter((s) => s.url.includes("/sync/v2/pull")).map((s) => s.url)).toEqual(["http://server/sync/v2/pull?after=0&limit=500"]);
    expect(server.store.blocks.size).toBe(30);
  });

  it("abgelehnter gzip-Push (400/415): einmal unkomprimiert wiederholen, danach dabei bleiben", async () => {
    const server = new FakeServer();
    const pushes: (string | null)[] = [];
    const persistence = new SqlitePersistence(openNodeDatabase());
    const store = new WorkspaceStore({ persistence, node: "client" });
    const client = new SyncClient(store, persistence, {
      baseURL: "http://server", token: server.token,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/sync/v2/info")) return new Response(JSON.stringify({ protocol: 2, seq: 0, oldestSeq: 0, sync: { gzip: true } }), { status: 200 });
        if (url.endsWith("/sync/v2/push")) {
          const enc = new Headers(init?.headers).get("content-encoding");
          pushes.push(enc);
          if (enc) return new Response("unsupported content encoding", { status: 415 });
        }
        return server.fetch(input, init);
      },
    });
    const write = (id: string) => store.transact("t", (tx) => tx.put({ kind: "block", data: { id, type: "page", parent: "w", sk: "a" + id, text: "long text ".repeat(200), createdAt: 0, updatedAt: 0 } }));
    write("one");
    expect((await client.syncOnce()).pushed).toBe(1);
    expect(pushes).toEqual(["gzip", null]);
    write("two");
    await client.syncOnce();
    expect(pushes).toEqual(["gzip", null, null]);
    expect(server.store.blocks.size).toBe(2);
  });
});
