// BSD-363: Bookmark „Fetch preview“ – Block während des Ladens gelöscht → keine falsche Fehlermeldung.
import { describe, expect, it, vi } from "vitest";
import { fetchBookmarkPreview } from "../src/ui/linkPreview.js";

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("fetchBookmarkPreview", () => {
  it("Block vor dem Auflösen gelöscht: still, kein notify, kein apply", async () => {
    const d = deferred<{ title?: string }>();
    let exists = true;
    const notify = vi.fn(), apply = vi.fn();
    const run = fetchBookmarkPreview("https://example.com", { fetch: () => d.promise, exists: () => exists, apply, notify });
    exists = false;
    d.resolve({ title: "Example" });
    expect(await run).toBe("gone");
    expect(notify).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
  it("Fehler beim Holen nach dem Löschen: ebenfalls still", async () => {
    const d = deferred<{ title?: string }>();
    let exists = true;
    const notify = vi.fn();
    const run = fetchBookmarkPreview("https://example.com", { fetch: () => d.promise, exists: () => exists, apply: vi.fn(), notify });
    exists = false;
    d.reject(new Error("offline"));
    expect(await run).toBe("gone");
    expect(notify).not.toHaveBeenCalled();
  });
  it("Schreiben wirft (Block zwischendurch weg): still", async () => {
    const notify = vi.fn();
    expect(await fetchBookmarkPreview("u", { fetch: async () => ({ title: "T" }), exists: () => true, apply: () => { throw new Error("Block not found"); }, notify })).toBe("gone");
    expect(notify).not.toHaveBeenCalled();
  });
  it("Normalfall, leere Vorschau und Netzfehler melden wie bisher", async () => {
    const apply = vi.fn(), notify = vi.fn();
    expect(await fetchBookmarkPreview("u", { fetch: async () => ({ title: "T" }), exists: () => true, apply, notify })).toBe("applied");
    expect(apply).toHaveBeenCalledWith({ title: "T" });
    expect(await fetchBookmarkPreview("u", { fetch: async () => ({}), exists: () => true, apply, notify })).toBe("empty");
    expect(await fetchBookmarkPreview("u", { fetch: async () => { throw new Error("x"); }, exists: () => true, apply, notify })).toBe("failed");
    expect(notify.mock.calls.map((c) => c[0])).toEqual(["That page didn’t share a title or description.", "Couldn’t fetch a preview for this link. Check the address and your connection."]);
  });
});
