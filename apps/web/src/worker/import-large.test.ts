// BSD-254: große Notion-Exporte (≥ 500 MB) importieren, ohne alles im Speicher zu halten. Ein künstliches ZIP von
// ~1 GB (Bilder überwiegend) wird nur virtuell erzeugt (Quelle setzt Bereiche beim Lesen zusammen) und mit der
// Streaming-Sammlung vorbereitet: die Speicherspitze bleibt weit unter der Dateigröße. Dazu: gleiches Ergebnis wie
// der bisherige Weg (ganzer Puffer).
import { readFileSync } from "node:fs";
import { crc32, MemoryAssetSink, writeZip, type ByteSource } from "@based/core";
import { describe, expect, it } from "vitest";
import { drainDeferred, prepareFiles, StreamingAssetSink, type StreamedAsset } from "./importer.js";

const enc = new TextEncoder();

/** Ein ZIP aus gespeicherten Einträgen, dessen Bytes erst beim Lesen entstehen. */
function virtualZip(entries: { name: string; size: number; fill: (offset: number, out: Uint8Array) => void; crc: number }[]): ByteSource & { reads: number; maxRead: number } {
  type Seg = { start: number; len: number; bytes?: Uint8Array; fill?: (offset: number, out: Uint8Array) => void };
  const segs: Seg[] = [];
  let pos = 0;
  const add = (s: Omit<Seg, "start">) => { segs.push({ ...s, start: pos }); pos += s.len; };
  const u16 = (v: number) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const central: number[] = [];
  for (const e of entries) {
    const name = enc.encode(e.name);
    const offset = pos;
    const head = new Uint8Array([...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(e.crc), ...u32(e.size), ...u32(e.size), ...u16(name.length), ...u16(0), ...name]);
    add({ len: head.length, bytes: head });
    add({ len: e.size, fill: e.fill });
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(e.crc), ...u32(e.size), ...u32(e.size),
      ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
  }
  const cdStart = pos;
  add({ len: central.length, bytes: new Uint8Array(central) });
  const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(cdStart), ...u16(0)]);
  add({ len: eocd.length, bytes: eocd });
  const size = pos;
  const src = {
    size,
    reads: 0,
    maxRead: 0,
    read(offset: number, length: number) {
      if (offset < 0 || offset + length > size) throw new RangeError("read past end");
      src.reads += 1;
      src.maxRead = Math.max(src.maxRead, length);
      const out = new Uint8Array(length);
      for (const s of segs) {
        const a = Math.max(offset, s.start), b = Math.min(offset + length, s.start + s.len);
        if (a >= b) continue;
        const part = out.subarray(a - offset, b - offset);
        if (s.bytes) part.set(s.bytes.subarray(a - s.start, b - s.start));
        else s.fill!(a - s.start, part);
      }
      return out;
    },
  };
  return src;
}

function bigExport() {
  const IMAGE = 10 << 20, COUNT = 100; // 100 × 10 MiB ≈ 1 GiB
  const block = new Uint8Array(IMAGE);
  for (let i = 0; i < IMAGE; i++) block[i] = (i * 2654435761) >>> 24;
  block.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crc = crc32(block);
  const dir = "Big 0123456789abcdef0123456789abcdef";
  const figures = Array.from({ length: COUNT }, (_, i) => `<figure id="b0000000-0000-4000-8000-${String(i).padStart(12, "0")}" class="image"><a href="${encodeURI(dir)}/img-${i}.png"><img src="${encodeURI(dir)}/img-${i}.png"/></a></figure>`).join("");
  const html = enc.encode(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/><title>Big</title></head><body><article id="01234567-89ab-cdef-0123-456789abcdef" class="page sans"><header><h1 class="page-title">Big</h1></header><div class="page-body">${figures}</div></article></body></html>`);
  const zip = virtualZip([
    { name: `${dir}.html`, size: html.length, crc: crc32(html), fill: (o, out) => out.set(html.subarray(o, o + out.length)) },
    ...Array.from({ length: COUNT }, (_, i) => ({ name: `${dir}/img-${i}.png`, size: IMAGE, crc, fill: (o: number, out: Uint8Array) => out.set(block.subarray(o, o + out.length)) })),
  ]);
  if (zip.size < 1_000_000_000) throw new Error("zu klein");
  return { IMAGE, COUNT, zip };
}

describe("BSD-254: große Exporte", () => {
  it("künstliches 1-GB-ZIP: Speicherspitze weit unter der Dateigröße, alle Bilder einzeln weitergereicht", () => {
    const { IMAGE, COUNT, zip } = bigExport();

    const base = process.memoryUsage().arrayBuffers;
    let peak = 0, streamed = 0;
    const sample = () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); };
    const seen: StreamedAsset[] = [];
    const sink = new StreamingAssetSink((a) => {
      streamed += a.data.length;
      seen.push({ ...a, data: new Uint8Array(0) }); // der Store-Worker legt sie ab; hier nichts behalten
      sample();
    });
    const payload = prepareFiles([{ path: "Export.zip", source: zip }], { assets: sink, progress: sample });
    sample();
    expect(payload.files).toBeUndefined();
    expect(payload.assets).toBe(COUNT);
    expect(seen).toHaveLength(COUNT);
    expect(streamed).toBe(COUNT * IMAGE);
    expect(payload.notion?.builder?.blocks.filter((b) => b.type === "image")).toHaveLength(COUNT);
    // Gemessen: höchstens wenige Einträge gleichzeitig im Speicher – nicht die Datei (≈ 1 GiB).
    console.info(`BSD-254: 1-GB-ZIP, Spitze ArrayBuffer ${Math.round(peak / (1 << 20))} MiB`);
    expect(peak).toBeLessThan(200 << 20);
    expect(zip.maxRead).toBeLessThanOrEqual(IMAGE + 1024);
  }, 120_000);

  it("gleiches Ergebnis wie aus dem ganzen Puffer (Notion-Fixture als ZIP)", () => {
    const fx = JSON.parse(readFileSync(new URL("../../../../fixtures/import/notion-html.utc.json", import.meta.url), "utf8")) as { cases: { input: { files?: { path: string; text?: string; base64?: string }[] } }[] };
    const entries = fx.cases[0]!.input.files!.map((f) => ({ path: "Export/" + f.path, data: f.base64 !== undefined ? Uint8Array.from(Buffer.from(f.base64, "base64")) : enc.encode(f.text ?? "") }));
    const bytes = writeZip(entries);
    const asSource: ByteSource = { size: bytes.length, read: (o, l) => bytes.slice(o, o + l) };
    const memory = new MemoryAssetSink(), streamedFiles: StreamedAsset[] = [];
    const a = prepareFiles([{ path: "Export.zip", data: bytes }], { assets: memory });
    const b = prepareFiles([{ path: "Export.zip", source: asSource }], { assets: new StreamingAssetSink((f) => streamedFiles.push(f)) });
    const shape = (p: typeof a) => (p.notion?.builder?.blocks ?? []).map((x) => [x.type, x.text]);
    expect(shape(b)).toEqual(shape(a));
    expect(b.notes).toEqual(a.notes);
    expect(b.assets).toBe(a.assets);
    expect(streamedFiles.map((f) => [f.name, f.data.length]).sort()).toEqual((a.files ?? []).map((f) => [f.name, f.data.length]).sort());
  });

  it("BSD-283: langsamer Store-Worker – mit Gegendruck bleibt die Spitze beim Fenster, nicht bei der Dateigröße", async () => {
    const { IMAGE, COUNT, zip } = bigExport();
    const base = process.memoryUsage().arrayBuffers;
    let peak = 0, streamed = 0, maxQueued = 0;
    const sample = () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); };
    const sink = new StreamingAssetSink(() => { throw new Error("Bilder sollen zurückgestellt werden"); }, { lazy: true });
    const payload = prepareFiles([{ path: "Export.zip", source: zip }], { assets: sink, progress: sample });
    sample();
    expect(sink.deferred).toHaveLength(COUNT);
    // Store-Worker: legt eine Datei nach der anderen ab, jede dauert einen Tick; bis dahin hält die Warteschlange sie.
    const queue: Uint8Array[] = [];
    let writer = Promise.resolve();
    const unreadable = await drainDeferred(sink, (a) => {
      queue.push(a.data);
      maxQueued = Math.max(maxQueued, queue.length);
      sample();
      writer = writer.then(() => new Promise<void>((r) => setTimeout(r, 1))).then(() => { streamed += queue.shift()!.length; sample(); });
      return writer;
    });
    expect(unreadable).toBe(0);
    expect(streamed).toBe(COUNT * IMAGE);
    expect(payload.assets).toBe(COUNT);
    console.info(`BSD-283: 1-GB-ZIP mit langsamem Store-Worker, Spitze ArrayBuffer ${Math.round(peak / (1 << 20))} MiB, höchstens ${maxQueued} Dateien in der Warteschlange`);
    expect(maxQueued).toBeLessThanOrEqual(4); // 32 MiB Fenster / 10 MiB je Bild
    expect(peak).toBeLessThan(200 << 20);
  }, 120_000);
});
