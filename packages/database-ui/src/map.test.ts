// Karte: Ort lesen/schreiben (wie Swift PlaceValue), Projektion, Ausschnitt, Bounds-Fit, Clustering.
import { describe, expect, it } from "vitest";
import { cluster, clampViewport, fitBounds, fromScreen, graticuleStep, mapHeightUnits, pan, project, ringsToPath, toScreen, unproject, worldSize, zoomAt } from "./map/geo.js";
import { coordinateError, encodePlace, hasCoordinates, parseCoordinate, parsePlace } from "./logic/place.js";
import { LAND_RINGS } from "./map/land.js";
import { mapRows } from "./map/rows.js";

const size = { width: 800, height: 600 };

describe("Ort", () => {
  it("liest JSON, Koordinaten-Text und Namen wie Swift", () => {
    expect(parsePlace('{"name":"Café","lat":48.2,"lon":16.37}')).toEqual({ name: "Café", lat: 48.2, lon: 16.37 });
    expect(parsePlace("48.1371, 11.5754")).toEqual({ lat: 48.1371, lon: 11.5754 });
    expect(parsePlace("Vienna")).toEqual({ name: "Vienna" });
    expect(parsePlace("{kaputt")).toEqual({ name: "{kaputt" });
    expect(parsePlace("")).toEqual({});
    expect(parsePlace('{"name":" ","google_place_id":"x"}')).toEqual({ extra: { google_place_id: "x" } });
  });
  it("schreibt wie PlaceValue.raw (sortiert, Name allein als Text) und behält unbekannte Felder", () => {
    expect(encodePlace({ name: "Home" })).toBe("Home");
    expect(encodePlace({ name: "Home", lat: 1, lon: 2 })).toBe('{"lat":1,"lon":2,"name":"Home"}');
    expect(encodePlace({ address: "Ring 1" })).toBe('{"address":"Ring 1"}');
    expect(encodePlace({ name: "A", extra: { google_place_id: "g" } })).toBe('{"google_place_id":"g","name":"A"}');
    expect(encodePlace({})).toBeUndefined();
    const raw = '{"address":"Main St","google_place_id":"g","lat":1.5,"lon":-2,"name":"X"}';
    expect(encodePlace(parsePlace(raw))).toBe(raw);
  });
  it("Koordinaten: vorhanden, Bereich, 0/0 zählt nicht", () => {
    expect(hasCoordinates({ lat: 1, lon: 2 })).toBe(true);
    expect(hasCoordinates({ lat: 0, lon: 0 })).toBe(false);
    expect(hasCoordinates({ lat: 91, lon: 0 })).toBe(false);
    expect(hasCoordinates({ lat: 1 })).toBe(false);
    expect(parseCoordinate(" 48,25 ")).toBe(48.25);
    expect(parseCoordinate("-.5")).toBe(-0.5);
    expect(parseCoordinate("")).toBeUndefined();
    expect(parseCoordinate("1e3")).toBeNaN();
    expect(coordinateError("1", "")).toBe("Enter both latitude and longitude");
    expect(coordinateError("", "")).toBeUndefined();
  });
});

describe("Web Mercator", () => {
  it("bekannte Punkte und Umkehrung", () => {
    expect(project({ lon: 0, lat: 0 })).toEqual({ x: 0.5, y: 0.5 });
    expect(project({ lon: -180, lat: 85.05112878 }).y).toBeCloseTo(0, 6);
    expect(project({ lon: 180, lat: -85.05112878 })).toEqual({ x: 1, y: expect.closeTo(1, 6) });
    expect(project({ lon: 0, lat: 90 }).y).toBeCloseTo(0, 6); // begrenzt
    for (const p of [{ lon: 16.37, lat: 48.21 }, { lon: -122.42, lat: 37.77 }, { lon: 151.2, lat: -33.87 }]) {
      const q = unproject(project(p));
      expect(q.lon).toBeCloseTo(p.lon, 9);
      expect(q.lat).toBeCloseTo(p.lat, 9);
    }
  });
  it("Bildschirm ⇄ Welt", () => {
    const vp = { cx: 0.5, cy: 0.5, zoom: 2 };
    expect(toScreen({ x: 0.5, y: 0.5 }, vp, size)).toEqual({ x: 400, y: 300 });
    expect(toScreen({ x: 0.75, y: 0.5 }, vp, size)).toEqual({ x: 400 + 256, y: 300 });
    expect(fromScreen({ x: 656, y: 300 }, vp, size)).toEqual({ x: 0.75, y: 0.5 });
    // Datumsgrenze: kürzester Weg
    expect(toScreen({ x: 0.02, y: 0.5 }, { cx: 0.98, cy: 0.5, zoom: 4 }, size).x).toBeCloseTo(400 + 0.04 * worldSize(4));
  });
  it("Zoomen um den Zeiger hält den Ort darunter fest; Pan und Grenzen", () => {
    const vp = { cx: 0.5, cy: 0.5, zoom: 3 };
    const at = { x: 600, y: 200 };
    const before = fromScreen(at, vp, size);
    const z = zoomAt(vp, 1, at, size);
    expect(z.zoom).toBe(4);
    const after = fromScreen(at, z, size);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(zoomAt(vp, 40, at, size).zoom).toBe(18);
    expect(pan(vp, 256, 0, size).cx).toBeCloseTo(0.5 - 256 / worldSize(3));
    expect(pan({ cx: 0.01, cy: 0.5, zoom: 3 }, 100, 0, size).cx).toBeGreaterThan(0.9); // umlaufend
    expect(clampViewport({ cx: 0.5, cy: 0, zoom: 3 }, size).cy).toBeCloseTo(300 / worldSize(3)); // nicht über den Rand
    expect(clampViewport({ cx: 0.5, cy: 0.1, zoom: 0 }, size)).toEqual({ cx: 0.5, cy: 0.5, zoom: Math.log2(600 / 256) }); // Welt füllt die Höhe
  });
});

describe("Bounds-Fit", () => {
  it("leer: Welt; ein Punkt: fester Zoom", () => {
    expect(fitBounds([], size).cy).toBe(0.5);
    const one = fitBounds([{ lon: 16.37, lat: 48.21 }], size, { singleZoom: 11 });
    expect(one.zoom).toBe(11);
    expect(unproject({ x: one.cx, y: one.cy }).lon).toBeCloseTo(16.37, 6);
  });
  it("alle Punkte liegen mit Rand im Bild", () => {
    const pts = [{ lon: 16.37, lat: 48.21 }, { lon: 13.4, lat: 52.52 }, { lon: 2.35, lat: 48.86 }, { lon: 12.5, lat: 41.9 }];
    const vp = fitBounds(pts, size, { padding: 40 });
    for (const p of pts) {
      const s = toScreen(project(p), vp, size);
      expect(s.x).toBeGreaterThanOrEqual(39.9);
      expect(s.x).toBeLessThanOrEqual(760.1);
      expect(s.y).toBeGreaterThanOrEqual(39.9);
      expect(s.y).toBeLessThanOrEqual(560.1);
    }
  });
  it("über die Datumsgrenze: die kurze Seite", () => {
    const vp = fitBounds([{ lon: 175, lat: -40 }, { lon: -175, lat: -40 }], size);
    expect(vp.zoom).toBeGreaterThan(3);
    expect(Math.abs(unproject({ x: vp.cx, y: vp.cy }).lon)).toBeCloseTo(180, 4);
  });
});

describe("Clustering", () => {
  it("fasst nahe Pins zusammen, lässt ferne einzeln", () => {
    const c = cluster([{ item: "a", x: 10, y: 10 }, { item: "b", x: 14, y: 12 }, { item: "c", x: 300, y: 300 }, { item: "d", x: 50, y: 10 }], 30);
    expect(c.map((x) => x.items.sort())).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(c[0]).toMatchObject({ x: 12, y: 11 });
  });
  it("Nachbarzellen über die Zellgrenze", () => {
    const c = cluster([{ item: 1, x: 29, y: 5 }, { item: 2, x: 31, y: 5 }], 30);
    expect(c).toHaveLength(1);
    expect(c[0]!.items).toEqual([1, 2]);
  });
  it("5.000 Pins in wenigen Millisekunden, keiner geht verloren", () => {
    const pts = Array.from({ length: 5000 }, (_, i) => ({ item: i, x: (i * 7919) % 800, y: (i * 104729) % 600 }));
    const t = performance.now();
    const c = cluster(pts, 40);
    expect(performance.now() - t).toBeLessThan(50);
    expect(c.reduce((n, x) => n + x.items.length, 0)).toBe(5000);
    expect(c.length).toBeLessThan(400);
  });
});

describe("Basiskarte und Gradnetz", () => {
  it("Land: Ringe mit gültigen Koordinaten, Pfad in Weltkoordinaten", () => {
    expect(LAND_RINGS.length).toBeGreaterThan(100);
    for (const r of LAND_RINGS) for (let i = 0; i < r.length; i += 2) {
      expect(Math.abs(r[i]!)).toBeLessThanOrEqual(180);
      expect(Math.abs(r[i + 1]!)).toBeLessThanOrEqual(90);
    }
    expect(ringsToPath([[0, 0, 10, 0, 10, 10]])).toMatch(/^M0\.50000 0\.50000L0\.52778 0\.50000L0\.52778 0\.47\d+Z$/);
  });
  it("Gradnetz wird mit dem Zoom feiner; Kartenhöhen", () => {
    expect(graticuleStep(0)).toBe(30);
    expect(graticuleStep(4)).toBeLessThan(graticuleStep(1));
    expect(graticuleStep(12)).toBe(0.1);
    expect(mapHeightUnits(undefined)).toBe(7);
    expect(mapHeightUnits("large")).toBe(9);
    expect(mapHeightUnits("huge")).toBe(7);
  });
});

describe("Zeilen auf der Karte", () => {
  const row = (id: string, place?: string) => ({ id, type: "page", parent: "d:db", sk: "a", text: id, createdAt: 0, updatedAt: 0, ...(place !== undefined ? { values: { p: { place: { _0: place } } } } : {}) });
  it("mit Koordinaten als Pin, sonst „ohne Ort“ (auch Text ohne Koordinaten)", () => {
    const r = mapRows([row("a", '{"lat":48.2,"lon":16.4,"name":"Wien"}'), row("b", "Somewhere"), row("c"), row("d", "48.1, 11.5")] as never, "p");
    expect(r.located.map((x) => [x.row.id, x.place.lat])).toEqual([["a", 48.2], ["d", 48.1]]);
    expect(r.unlocated.map((x) => [x.row.id, x.label])).toEqual([["b", "Somewhere"], ["c", ""]]);
  });
});
