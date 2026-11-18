// @vitest-environment jsdom
// BSD-266: Bild-Cache der Board-Fläche – lädt erst auf Nachfrage, hält nur die zuletzt gebrauchten.
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardImageCache } from "../src/whiteboard/images.js";

const bitmap = () => ({ width: 10, height: 10, close: vi.fn() }) as unknown as ImageBitmap;
afterEach(() => vi.unstubAllGlobals());

describe("BoardImageCache", () => {
  it("lädt beim ersten Fragen, meldet sich, liefert danach das Bild – und lädt nicht doppelt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob(["x"]) })));
    const resolve = vi.fn(async (ref: string) => "blob:" + ref);
    const loaded = vi.fn();
    const cache = new BoardImageCache(resolve, loaded, async () => bitmap());
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("a")).toBeUndefined();
    await vi.waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
    expect(cache.get("a")).toBeDefined();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("hält höchstens `max` Bilder und gibt die ältesten frei", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ blob: async () => new Blob(["x"]) })));
    const made: ImageBitmap[] = [];
    const loaded = vi.fn();
    const cache = new BoardImageCache(async (r) => r, loaded, async () => { const b = bitmap(); made.push(b); return b; }, 2);
    for (const ref of ["a", "b", "c"]) {
      cache.get(ref);
      await vi.waitFor(() => expect(cache.get(ref)).toBeDefined());
    }
    expect(made[0]!.close).toHaveBeenCalled();
    expect(made[2]!.close).not.toHaveBeenCalled();
    cache.destroy();
    expect(made[2]!.close).toHaveBeenCalled();
  });
  it("eine Datei, die nicht kommt, bleibt ein Platzhalter und stört die anderen nicht", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const loaded = vi.fn();
    const cache = new BoardImageCache(async (r) => r, loaded, async () => bitmap());
    expect(cache.get("gone")).toBeUndefined();
    await new Promise((r) => setTimeout(r, 10));
    expect(cache.get("gone")).toBeUndefined();
    expect(loaded).not.toHaveBeenCalled();
  });
});
