// BSD-78: reine Teile von assets.ts (Hash, Typ-Erkennung, Warteschlange). Der Ablauf gegen einen Server über HTTP
// steht in apps/server/test/assets.test.ts.
import { describe, expect, it } from "vitest";
import { ASSET_QUEUE_KEY, AssetSync, isAssetHash, MemoryAssetBlobStore, safeBlobType, sha256Hex } from "../src/index.js";

const text = (s: string) => new TextEncoder().encode(s);

describe("Assets", () => {
  it("sha256Hex und isAssetHash", async () => {
    expect(await sha256Hex(text("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(isAssetHash("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")).toBe(true);
    expect(isAssetHash("BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD")).toBe(false);
    expect(isAssetHash("0F2B6C1E-1111-4222-8333-444455556666")).toBe(false);
  });

  it("safeBlobType: nur gefahrlos anzeigbare Typen, HTML und SVG nie", () => {
    expect(safeBlobType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("image/png");
    expect(safeBlobType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(safeBlobType(text("GIF89a"))).toBe("image/gif");
    expect(safeBlobType(text("RIFF....WEBPVP8 "))).toBe("image/webp");
    expect(safeBlobType(text("%PDF-1.7"))).toBe("application/pdf");
    expect(safeBlobType(text("....ftypisom"))).toBe("video/mp4");
    expect(safeBlobType(text("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"))).toBe("application/octet-stream");
    expect(safeBlobType(text("<!doctype html><script>alert(1)</script>"))).toBe("application/octet-stream");
    expect(safeBlobType(new Uint8Array())).toBe("application/octet-stream");
  });

  it("Warteschlange liegt in meta, übersteht einen Neustart und verwirft kaputte Einträge", async () => {
    const meta = new Map<string, string>();
    const store = { meta: (k: string) => meta.get(k), setMeta: (k: string, v: string | undefined) => void (v === undefined ? meta.delete(k) : meta.set(k, v)) };
    const blobs = new MemoryAssetBlobStore();
    const a = new AssetSync(blobs, store); // kein Server: nur vormerken
    const ref = await a.add(text("hallo"), "", undefined);
    expect(ref).toEqual({ id: await sha256Hex(text("hallo")), name: "file", size: 5 });
    await a.add(text("hallo"), "nochmal.txt");
    expect(JSON.parse(meta.get(ASSET_QUEUE_KEY)!)).toEqual([{ hash: ref.id, size: 5 }]);
    await a.flush();
    expect(a.status()).toMatchObject({ pending: 1, failed: 0 });
    await expect(a.get("f".repeat(64))).rejects.toMatchObject({ code: "no-server" });
    expect(new TextDecoder().decode(await a.get(ref.id))).toBe("hallo");

    meta.set(ASSET_QUEUE_KEY, JSON.stringify([{ hash: ref.id, size: 5 }, { hash: "kaputt", size: 1 }, 7, null]));
    expect(new AssetSync(blobs, store).queued).toEqual([{ hash: ref.id, size: 5 }]);
    meta.set(ASSET_QUEUE_KEY, "{kein json");
    expect(new AssetSync(blobs, store).queued).toEqual([]);
  });
});
