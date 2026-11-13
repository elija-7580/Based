// BSD-231 Teil 1: lokale Modelle nur per Opt-in – ohne Einwilligung keine Anfrage, gepinnte Quelle mit Prüfsumme,
// Fortschritt, Abbruch, nichts Halbes gespeichert, danach offline.
import { describe, expect, it } from "vitest";
import { localModels as lm } from "../src/index.js";

const enc = new TextEncoder();
const A = enc.encode("model weights part A, pretend".repeat(10));
const B = enc.encode("tokenizer.json, pretend");

async function spec(over: Partial<lm.LocalModelFile> = {}): Promise<lm.LocalModelSpec> {
  return {
    id: "whisper-tiny", purpose: "transcription", name: "Whisper tiny", version: "1", license: "MIT",
    files: [
      { path: "model.bin", url: "https://models.example/whisper/model.bin", size: A.length, sha256: await lm.sha256Hex(A), ...over },
      { path: "tok/tokenizer.json", size: B.length, sha256: await lm.sha256Hex(B) },
    ],
  };
}

function net(files: Record<string, Uint8Array>) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    init?.signal?.throwIfAborted();
    const body = files[u];
    if (!body) return new Response("nope", { status: 404 });
    // in zwei Stücken, damit Fortschritt sichtbar ist
    const half = Math.floor(body.length / 2);
    return new Response(new ReadableStream({ start(c) { c.enqueue(body.slice(0, half)); c.enqueue(body.slice(half)); c.close(); } }));
  }) as typeof fetch;
  return { calls, fetcher };
}

const SERVER = "https://my-based.example";
const urls = { "https://models.example/whisper/model.bin": A, [`${SERVER}/models/whisper-tiny/tok/tokenizer.json`]: B };

describe("Lokale Modelle (BSD-231 Teil 1)", () => {
  it("ohne Opt-in: keine einzige Anfrage", async () => {
    const { calls, fetcher } = net(urls);
    const m = new lm.LocalModelManager({ store: new lm.MemoryLocalModelStore(), fetch: fetcher, consent: () => new Set(["embeddings"]), server: () => SERVER });
    await expect(m.download(await spec())).rejects.toBeInstanceOf(lm.ConsentRequired);
    expect(await m.installed(await spec())).toBe(false);
    expect(calls).toEqual([]);
  });

  it("mit Opt-in: lädt mit Fortschritt (feste URL + eigener Server), prüft, danach offline nutzbar", async () => {
    const { calls, fetcher } = net(urls);
    const store = new lm.MemoryLocalModelStore();
    const m = new lm.LocalModelManager({ store, fetch: fetcher, consent: () => new Set(["transcription"]), server: () => SERVER + "/" });
    const progress: number[] = [];
    const s = await spec();
    await m.download(s, { onProgress: (p) => progress.push(p.loaded) });
    expect(calls).toEqual(["https://models.example/whisper/model.bin", `${SERVER}/models/whisper-tiny/tok/tokenizer.json`]);
    expect(progress[progress.length - 1]).toBe(A.length + B.length);
    expect(progress.length).toBeGreaterThan(2);
    expect(await m.installed(s)).toBe(true);
    // offline: zweiter Aufruf lädt nichts, Datei kommt aus dem Speicher
    const off = new lm.LocalModelManager({ store, fetch: (() => { throw new Error("offline"); }) as typeof fetch, consent: () => new Set(["transcription"]) });
    await off.download(s);
    expect(await off.file(s, "model.bin")).toEqual(A);
    await m.remove(s);
    expect(await m.installed(s)).toBe(false);
  });

  it("falsche Prüfsumme, falsche Größe, kaputter Katalog: nichts wird gespeichert", async () => {
    const { fetcher } = net(urls);
    const store = new lm.MemoryLocalModelStore();
    const m = new lm.LocalModelManager({ store, fetch: fetcher, consent: () => new Set(["transcription"]), server: () => SERVER });
    await expect(m.download(await spec({ sha256: "0".repeat(64) }))).rejects.toThrow(/checksum/);
    await expect(m.download(await spec({ size: A.length - 1 }))).rejects.toThrow(/larger than expected/);
    await expect(m.download(await spec({ size: A.length + 5 }))).rejects.toThrow(/size/);
    expect(store.files.size).toBe(0);
    expect(lm.validateSpec(await spec({ url: "http://insecure.example/x" }))).toEqual(["model.bin: only https sources"]);
    expect(lm.validateSpec(await spec({ path: "../etc/passwd" }))[0]).toMatch(/unsafe path/);
    await expect(m.download(await spec({ path: "../x" }))).rejects.toBeInstanceOf(lm.ModelIntegrityError);
    // ohne feste URL und ohne Server: klare Meldung statt Anfrage ins Blaue
    const noServer = new lm.LocalModelManager({ store, fetch: fetcher, consent: () => new Set(["transcription"]) });
    const s = await spec();
    await expect(noServer.download({ ...s, files: [s.files[1]!] })).rejects.toThrow(/no source/);
  });

  it("Abbruch: bricht ab, speichert nichts", async () => {
    const { fetcher } = net(urls);
    const store = new lm.MemoryLocalModelStore();
    const m = new lm.LocalModelManager({ store, fetch: fetcher, consent: () => new Set(["transcription"]), server: () => SERVER });
    const ac = new AbortController();
    await expect(m.download(await spec(), { signal: ac.signal, onProgress: () => ac.abort() })).rejects.toThrow();
    expect(store.files.size).toBe(0);
  });
});
