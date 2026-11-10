// Sync-Token verschlüsselt speichern (WebCrypto, nicht extrahierbarer Schlüssel) und alte Klartext-Einträge übernehmen.
import { describe, expect, it } from "vitest";
import { LEGACY_SYNC_KEY, memoryKV, SecretStore } from "./secrets.js";
import { syncConfig } from "./storage.js";

function fakeLocalStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => void m.delete(k) };
}

describe("Token-Speicher", () => {
  it("speichert das Token nur verschlüsselt und liest es wieder", async () => {
    const kv = memoryKV();
    const s = new SecretStore(kv);
    await s.setSync({ url: "https://sync.example", token: "very-secret-token" });
    expect(await s.getSync()).toEqual({ url: "https://sync.example", token: "very-secret-token" });

    // nirgends im Klartext
    const sealed = kv.map.get("sync") as { url: string; iv: Uint8Array; data: ArrayBuffer };
    const bytes = new TextDecoder("latin1").decode(new Uint8Array(sealed.data));
    expect(bytes).not.toContain("very-secret-token");
    expect(JSON.stringify(sealed)).not.toContain("very-secret-token");
    expect(sealed.iv.byteLength).toBe(12);

    // Schlüssel ist nicht extrahierbar
    const key = kv.map.get("key") as CryptoKey;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();

    // jedes Speichern mit neuem IV, derselbe Schlüssel
    await s.setSync({ url: "https://sync.example", token: "very-secret-token" });
    expect((kv.map.get("sync") as { iv: Uint8Array }).iv).not.toEqual(sealed.iv);
    expect(kv.map.get("key")).toBe(key);

    await s.setSync(undefined);
    expect(await s.getSync()).toBeUndefined();
  });

  it("anderer Schlüssel (Profil teilweise zurückgesetzt): Server bleibt, Token leer", async () => {
    const kv2 = memoryKV();
    await new SecretStore(kv2).setSync({ url: "https://b", token: "x" });
    kv2.map.set("key", await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]));
    expect(await new SecretStore(kv2).getSync()).toEqual({ url: "https://b", token: "" });
  });

  it("übernimmt den alten Klartext-Eintrag aus localStorage und löscht ihn dort", async () => {
    const kv = memoryKV();
    const s = new SecretStore(kv);
    const ls = fakeLocalStorage({ [LEGACY_SYNC_KEY]: JSON.stringify({ url: "https://old", token: "legacy" }), other: "x" });
    await s.migrate(ls);
    expect(ls.m.has(LEGACY_SYNC_KEY)).toBe(false);
    expect(ls.m.get("other")).toBe("x");
    expect(await s.getSync()).toEqual({ url: "https://old", token: "legacy" });

    // vorhandener verschlüsselter Eintrag gewinnt über einen späteren Klartext-Rest
    ls.m.set(LEGACY_SYNC_KEY, JSON.stringify({ url: "https://stale", token: "stale" }));
    await s.migrate(ls);
    expect(await s.getSync()).toEqual({ url: "https://old", token: "legacy" });
    expect(ls.m.has(LEGACY_SYNC_KEY)).toBe(false);

    // kaputter Eintrag: wird entfernt, nichts übernommen
    const kv2 = memoryKV();
    const ls2 = fakeLocalStorage({ [LEGACY_SYNC_KEY]: "{nope" });
    await new SecretStore(kv2).migrate(ls2);
    expect(ls2.m.size).toBe(0);
    expect(await new SecretStore(kv2).getSync()).toBeUndefined();
  });

  it("syncConfig: synchron lesen, verschlüsselt im Hintergrund schreiben, beim Laden zurück", async () => {
    const kv = memoryKV();
    syncConfig._use(new SecretStore(kv));
    syncConfig.set({ url: "https://s", token: "abc" });
    expect(syncConfig.get()).toEqual({ url: "https://s", token: "abc" });
    syncConfig._use(new SecretStore(kv));
    expect(syncConfig.get()).toBeUndefined();
    expect(await syncConfig.load()).toEqual({ url: "https://s", token: "abc" });
    syncConfig.set(undefined);
    expect(await syncConfig.load()).toBeUndefined();
    // BSD-220: Echtzeit-Text bleibt erhalten (Klartext-Feld, Token weiter verschlüsselt)
    syncConfig.set({ url: "https://s", token: "abc", collab: true });
    syncConfig._use(new SecretStore(kv));
    expect(await syncConfig.load()).toEqual({ url: "https://s", token: "abc", collab: true });
    syncConfig.set(undefined);
  });

  it("syncConfig.flush: danach liegt der Wert im Speicher, ein frischer Leser findet ihn", async () => {
    const kv = memoryKV();
    syncConfig._use(new SecretStore(kv));
    syncConfig.set({ url: "https://flush", token: "t" });
    await syncConfig.flush();
    expect(await new SecretStore(kv).getSync()).toEqual({ url: "https://flush", token: "t" });
  });
});
