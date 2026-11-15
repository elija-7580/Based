// BSD-231 Teil 2c (Kern): lokale Modelle über den Store-Worker – Status, laden mit Fortschritt (nur mit Einwilligung:
// sonst keine einzige Anfrage), abbrechen, entfernen. Die Einstellungen (Schicht B) bauen den Schalter darauf.
import { openWorkspace } from "@based/sync";
import { openNodeDatabase } from "@based/sync/node";
import { localModels } from "@based/brain";
import { afterEach, describe, expect, it } from "vitest";
import { StoreClient } from "./client.js";
import { StoreHost } from "./host.js";
import type { Endpoint, Event, RequestMessage } from "./protocol.js";

type Fn<T> = (e: { data: T }) => void;
let hosts: StoreHost[] = [];
afterEach(() => { hosts.forEach((h) => h.stop()); hosts = []; });

async function spec(id: string, bytes: Uint8Array, purpose: localModels.LocalModelPurpose = "embeddings"): Promise<localModels.LocalModelSpec> {
  return { id, purpose, name: id, version: "1", license: "MIT", files: [{ path: "model.bin", url: `https://models.example/${id}`, size: bytes.length, sha256: await localModels.sha256Hex(bytes) }] };
}

function setup(catalog: localModels.LocalModelSpec[], fetcher: typeof fetch) {
  const toHost = new Set<Fn<RequestMessage>>();
  const toClient = new Set<Fn<Event>>();
  const end: Endpoint<Event, RequestMessage> = {
    postMessage: (m) => setTimeout(() => toHost.forEach((f) => f({ data: structuredClone(m) }))),
    addEventListener: (_t, f) => toClient.add(f),
    removeEventListener: (_t, f) => toClient.delete(f),
  };
  const db = openNodeDatabase(":memory:");
  const store = new localModels.MemoryLocalModelStore();
  const host = new StoreHost({
    post: (e) => { const c = structuredClone(e); setTimeout(() => toClient.forEach((f) => f({ data: c }))); },
    open: async ({ device }) => ({ ...openWorkspace(db, { device }), persistent: true }),
    defer: (fn) => setTimeout(fn, 0),
    fetch: fetcher,
    openModels: async () => store,
    modelCatalog: catalog,
  });
  hosts.push(host);
  let queue = Promise.resolve();
  toHost.add((e) => { queue = queue.then(() => host.handle(e.data)); });
  return { client: new StoreClient(end), store };
}

describe("BSD-231 lokale Modelle im Store-Worker", () => {
  it("ohne Einwilligung keine Anfrage; mit Einwilligung laden mit Fortschritt; entfernen", async () => {
    const bytes = new Uint8Array(4000).map((_, i) => i % 251);
    const catalog = [await spec("e5-test", bytes), await spec("whisper-test", new Uint8Array([1, 2, 3]), "transcription")];
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(String(url));
      // in Stücken, damit Fortschritt kommt
      const body = new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += 1000) c.enqueue(bytes.slice(i, i + 1000)); c.close(); } });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const { client, store } = setup(catalog, fetcher);
    await client.init({ device: "dev" });

    const status = await client.localModels({ op: "status" }, []);
    expect(status.map((m) => [m.id, m.purpose, m.size, m.installed, m.downloading])).toEqual([["e5-test", "embeddings", 4000, false, false], ["whisper-test", "transcription", 3, false, false]]);

    await expect(client.localModels({ op: "download", id: "e5-test" }, ["transcription"])).rejects.toThrow(/models are off/);
    expect(asked).toEqual([]);

    const progress: { loaded: number; done?: boolean }[] = [];
    client.modelProgress.add((p) => { if (p.id === "e5-test") progress.push({ loaded: p.loaded, ...(p.done ? { done: true } : {}) }); });
    const after = await client.localModels({ op: "download", id: "e5-test" }, ["embeddings"]);
    expect(asked).toEqual(["https://models.example/e5-test"]);
    expect(after.find((m) => m.id === "e5-test")).toMatchObject({ installed: true, downloading: false });
    await new Promise((r) => setTimeout(r, 10));
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toEqual({ loaded: 4000, done: true });
    expect([...store.files.keys()]).toEqual(["e5-test/1/model.bin"]);

    const removed = await client.localModels({ op: "remove", id: "e5-test" }, ["embeddings"]);
    expect(removed.find((m) => m.id === "e5-test")?.installed).toBe(false);
    expect(store.files.size).toBe(0);
    await expect(client.localModels({ op: "download", id: "nope" }, ["embeddings"])).rejects.toThrow(/unknown model/);
  });

  it("abbrechen: Download endet mit „cancelled“, nichts gespeichert; die Warteschlange des Workers läuft weiter", async () => {
    const bytes = new Uint8Array(3000).fill(7);
    const catalog = [await spec("slow", bytes)];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          await Promise.race([gate, new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))]);
          c.enqueue(bytes); c.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const { client, store } = setup(catalog, fetcher);
    await client.init({ device: "dev" });
    const events: { done?: boolean; error?: string }[] = [];
    client.modelProgress.add((p) => events.push({ ...(p.done ? { done: true } : {}), ...(p.error ? { error: p.error } : {}) }));
    const running = client.localModels({ op: "download", id: "slow" }, ["embeddings"]);
    await new Promise((r) => setTimeout(r, 20));
    // die Schlange ist frei: andere Anfragen werden beantwortet, Status sagt „lädt“
    expect((await client.localModels({ op: "status" }, ["embeddings"]))[0]).toMatchObject({ downloading: true, installed: false });
    expect(await client.command({ op: "createPage", title: "Still responsive" })).toBeTruthy();
    await client.localModels({ op: "cancel", id: "slow" }, ["embeddings"]);
    const r = await running;
    release();
    expect(r[0]).toMatchObject({ installed: false, downloading: false });
    await new Promise((res) => setTimeout(res, 10));
    expect(events.at(-1)).toEqual({ done: true, error: "cancelled" });
    expect(store.files.size).toBe(0);
  });
});
