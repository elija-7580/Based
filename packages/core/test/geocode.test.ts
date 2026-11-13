// BSD-232 Teil 1: Adresse nachschlagen (nur auf Knopfdruck) und Online-Kacheln (Opt-in) – reine Logik ohne Netz.
import { describe, expect, it } from "vitest";
import { DEFAULT_GEOCODER, geocodeURL, lookupAddress, parseGeocode, tileURL, validateTiles, visibleTiles, type GeocoderConfig } from "../src/index.js";

const NOMINATIM: GeocoderConfig = { kind: "nominatim", url: "https://nominatim.example.org" };

describe("BSD-232: Geocoding", () => {
  it("baut Anfragen für Photon und Nominatim, nur https (localhost auch http)", () => {
    const p = new URL(geocodeURL(DEFAULT_GEOCODER, "  Stephansplatz 1, Wien ", { lang: "de", limit: 50 }));
    expect(p.origin + p.pathname).toBe("https://photon.komoot.io/api/");
    expect(p.searchParams.get("q")).toBe("Stephansplatz 1, Wien");
    expect(p.searchParams.get("limit")).toBe("10");
    expect(p.searchParams.get("lang")).toBe("de");
    expect(new URL(geocodeURL(DEFAULT_GEOCODER, "x", { lang: "ja" })).searchParams.has("lang")).toBe(false);
    const n = new URL(geocodeURL({ kind: "nominatim", url: "https://geo.example.org/nominatim" }, "Graz"));
    expect(n.pathname).toBe("/nominatim/search");
    expect(n.searchParams.get("format")).toBe("jsonv2");
    expect(n.searchParams.get("limit")).toBe("5");
    expect(geocodeURL({ kind: "photon", url: "http://localhost:2322" }, "a")).toMatch(/^http:\/\/localhost:2322\/api\//);
    expect(() => geocodeURL({ kind: "photon", url: "http://photon.example.org" }, "a")).toThrow(/https/);
    expect(() => geocodeURL(DEFAULT_GEOCODER, "   ")).toThrow(/address/);
  });

  it("liest Photon- und Nominatim-Antworten, überspringt kaputte Einträge", () => {
    const photon = {
      features: [
        { geometry: { coordinates: [16.3725, 48.2084] }, properties: { name: "Stephansdom", street: "Stephansplatz", housenumber: "3", postcode: "1010", city: "Wien", country: "Österreich" } },
        { geometry: { coordinates: [15.44, 47.07] }, properties: { street: "Hauptplatz", postcode: "8010", city: "Graz" } },
        { geometry: { coordinates: ["x", 1] }, properties: { name: "kaputt" } },
        { geometry: { coordinates: [200, 1] }, properties: { name: "außerhalb" } },
        { geometry: { coordinates: [1, 1] }, properties: {} },
        null,
      ],
    };
    expect(parseGeocode(DEFAULT_GEOCODER, photon)).toEqual([
      { name: "Stephansdom", address: "Stephansplatz 3, 1010 Wien, Österreich", lat: 48.2084, lon: 16.3725 },
      { name: "Hauptplatz", address: "Hauptplatz, 8010 Graz", lat: 47.07, lon: 15.44 },
    ]);
    expect(parseGeocode(DEFAULT_GEOCODER, { nope: 1 })).toEqual([]);
    const nom = [
      { lat: "48.2", lon: "16.37", display_name: "Wien, Österreich", name: "Wien" },
      { lat: "47.07", lon: "15.44", display_name: "Graz, Steiermark, Österreich" },
      { lat: "abc", lon: "1", display_name: "kaputt" },
      { lat: "1", lon: "1" },
    ];
    expect(parseGeocode(NOMINATIM, nom)).toEqual([
      { name: "Wien", address: "Wien, Österreich", lat: 48.2, lon: 16.37 },
      { name: "Graz", address: "Graz, Steiermark, Österreich", lat: 47.07, lon: 15.44 },
    ]);
    expect(parseGeocode(NOMINATIM, null)).toEqual([]);
  });

  it("fragt nur beim Aufruf an, ohne Cookies und Referrer; verständliche Fehler", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const ok = (async (u: string, init?: RequestInit) => {
      calls.push([u, init]);
      return new Response(JSON.stringify([{ lat: "1", lon: "2", display_name: "Somewhere" }]), { status: 200 });
    }) as unknown as typeof fetch;
    expect(calls).toHaveLength(0);
    expect(await lookupAddress(ok, NOMINATIM, "Somewhere", { lang: "en" })).toEqual([{ name: "Somewhere", address: "Somewhere", lat: 1, lon: 2 }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    expect(new URL(calls[0]![0]).searchParams.get("accept-language")).toBe("en");

    const status = (s: number) => (async () => new Response("x", { status: s })) as unknown as typeof fetch;
    await expect(lookupAddress(status(429), NOMINATIM, "a")).rejects.toThrow(/busy/);
    await expect(lookupAddress(status(500), NOMINATIM, "a")).rejects.toThrow(/answered 500/);
    const garbage = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(lookupAddress(garbage, NOMINATIM, "a")).rejects.toThrow(/unreadable/);
    const offline = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    await expect(lookupAddress(offline, NOMINATIM, "a")).rejects.toThrow(/can't be reached/);
    const ctl = new AbortController();
    ctl.abort();
    const aborting = (async () => { throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch;
    await expect(lookupAddress(aborting, NOMINATIM, "a", { signal: ctl.signal })).rejects.toThrow(/aborted/);
  });
});

describe("BSD-232: Online-Kacheln (Opt-in)", () => {
  const osm = { template: "https://{s}.tile.example.org/{z}/{x}/{y}.png", attribution: "© OpenStreetMap contributors" };

  it("prüft Vorlagen", () => {
    expect(validateTiles(osm)).toEqual([]);
    expect(validateTiles({ template: "http://tiles.example.org/{z}/{x}.png", attribution: " " })).toEqual([
      "Use an https:// address for the map service.",
      "The address needs {y}.",
      "Map tiles need the provider's attribution.",
    ]);
    expect(validateTiles({ template: "http://localhost:8080/{z}/{x}/{y}.png", attribution: "own" })).toEqual([]);
    expect(validateTiles({ template: "not a url {z}{x}{y}", attribution: "a" })).toHaveLength(1);
  });

  it("Kachel-Adresse läuft waagrecht um", () => {
    expect(tileURL(osm, 2, 1, 1)).toBe("https://c.tile.example.org/2/1/1.png");
    expect(tileURL(osm, 2, -1, 0)).toBe("https://a.tile.example.org/2/3/0.png");
    expect(tileURL(osm, 2, 5, 0)).toBe("https://b.tile.example.org/2/1/0.png");
  });

  it("sichtbare Kacheln überdecken den Ausschnitt, senkrecht abgeschnitten", () => {
    // Zoom 1: Welt 512 px, Ausschnitt 512×512 um die Mitte → alle 4 Kacheln
    const a = visibleTiles({ cx: 256, cy: 256, zoom: 1, width: 510, height: 510 });
    expect(a.z).toBe(1);
    expect(a.scale).toBe(1);
    expect(a.tiles).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]);
    // Bruchteil-Zoom: ganzzahliger Kachel-Zoom, Skalierung dazu
    const b = visibleTiles({ cx: 1000, cy: 1000, zoom: 3.4, width: 300, height: 200 });
    expect(b.z).toBe(3);
    expect(b.scale).toBeCloseTo(2 ** 0.4);
    // oben am Rand: keine negativen y
    const c = visibleTiles({ cx: 256, cy: 0, zoom: 2, width: 800, height: 800 });
    expect(c.tiles.every((t) => t.y >= 0 && t.y <= 3)).toBe(true);
    expect(c.tiles.some((t) => t.x < 0)).toBe(true);
    expect(visibleTiles({ cx: 0, cy: 0, zoom: 22, width: 10, height: 10 }, 19).z).toBe(19);
  });
});
