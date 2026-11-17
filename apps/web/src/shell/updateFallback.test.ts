import { describe, expect, it } from "vitest";
import { checkReleasesFallback, compareVersions, isMissingUpdateManifest, newestNextVersion, releaseLine } from "./updateFallback.js";

describe("updateFallback", () => {
  it("vergleicht Versionen numerisch", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("0.1.5", "0.1.5")).toBe(0);
    expect(compareVersions("0.1", "0.1.1")).toBe(-1);
  });

  it("findet die neueste next-Version und ignoriert next-latest, Swift-Releases und Entwürfe", () => {
    expect(newestNextVersion([
      { tag_name: "next-latest" }, { tag_name: "v0.1.298" }, { tag_name: "next-0.1.5" }, { tag_name: "next-0.1.12" },
      { tag_name: "next-0.1.99", draft: true }, { tag_name: 3 },
    ])).toBe("0.1.12");
    expect(newestNextVersion([])).toBeUndefined();
  });

  it("Based Beta sucht nur in der eigenen Linie beta-v<version>, Based Next nur in next-<version>", async () => {
    const all = [{ tag_name: "next-0.1.155" }, { tag_name: "beta-v0.2.2" }, { tag_name: "beta-v0.2.10" }, { tag_name: "beta-latest" }];
    const beta = releaseLine("beta");
    expect(newestNextVersion(all, beta.tagPrefix)).toBe("0.2.10");
    expect(newestNextVersion(all, releaseLine("dev").tagPrefix)).toBe("0.1.155");
    expect(beta.downloadPage).toMatch(/beta-latest$/);
    expect(releaseLine("dev").downloadPage).toMatch(/next-latest$/);
    const ok = (async () => new Response(JSON.stringify(all), { status: 200 })) as unknown as typeof fetch;
    // 0.2.2 ist in der Beta-Linie nicht „älter als next-0.1.155“ und nicht „neuer“ – es zählt nur die eigene Linie.
    expect(await checkReleasesFallback("0.2.10", ok, beta.tagPrefix)).toEqual({ kind: "current" });
    expect(await checkReleasesFallback("0.2.2", ok, beta.tagPrefix)).toEqual({ kind: "newer", version: "0.2.10" });
  });

  it("erkennt die Meldung „kein Update-Kanal“", () => {
    expect(isMissingUpdateManifest("Could not fetch a valid release JSON from the remote")).toBe(true);
    expect(isMissingUpdateManifest("network unreachable")).toBe(false);
  });

  it("meldet eine neuere Version aus den Releases", async () => {
    const ok = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    expect(await checkReleasesFallback("0.1.5", ok([{ tag_name: "next-0.1.7" }]))).toEqual({ kind: "newer", version: "0.1.7" });
    expect(await checkReleasesFallback("0.1.7", ok([{ tag_name: "next-0.1.7" }]))).toEqual({ kind: "current" });
    const fail = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await checkReleasesFallback("0.1.5", fail)).toEqual({ kind: "unknown" });
  });
});
