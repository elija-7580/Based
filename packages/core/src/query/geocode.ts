// BSD-232 Teil 1: Kartenansicht – Adresse nachschlagen (nur auf Knopfdruck) und Online-Kacheln (nur per Opt-in).
// Entscheidung Elija 10.11.: Standard bleibt die Offline-Karte; Kacheln und Geocoding mit datenschutzfreundlichem,
// konfigurierbarem Anbieter (auch selbst gehostet). Reine Funktionen + ein Abruf mit hineingereichtem `fetch`;
// ohne ausdrücklichen Aufruf geht nichts ins Netz.

/** Geocoding-Dienst: Nominatim-kompatibel (OpenStreetMap, selbst gehostet) oder Photon (komoot, selbst gehostet). */
export interface GeocoderConfig {
  kind: "nominatim" | "photon";
  /** Basis-Adresse, z. B. https://nominatim.openstreetmap.org oder https://photon.komoot.io */
  url: string;
}

export const DEFAULT_GEOCODER: GeocoderConfig = { kind: "photon", url: "https://photon.komoot.io" };

export interface GeocodeHit {
  name: string;
  address: string;
  lat: number;
  lon: number;
}

const httpsOnly = (u: string) => {
  const url = new URL(u);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname))) throw new Error("Use an https:// address for the map service.");
  return url;
};

/** Anfrage-URL für eine Adresse (höchstens `limit` Treffer, Sprache für die Namen). */
export function geocodeURL(cfg: GeocoderConfig, query: string, opts: { limit?: number; lang?: string } = {}): string {
  const q = query.trim();
  if (!q) throw new Error("Type an address first.");
  const base = httpsOnly(cfg.url);
  const limit = String(Math.max(1, Math.min(10, opts.limit ?? 5)));
  if (cfg.kind === "photon") {
    const u = new URL("api/", base.href.endsWith("/") ? base.href : base.href + "/");
    u.searchParams.set("q", q);
    u.searchParams.set("limit", limit);
    if (opts.lang && ["en", "de", "fr", "it"].includes(opts.lang)) u.searchParams.set("lang", opts.lang);
    return u.href;
  }
  const u = new URL("search", base.href.endsWith("/") ? base.href : base.href + "/");
  u.searchParams.set("q", q);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("addressdetails", "0");
  u.searchParams.set("limit", limit);
  if (opts.lang) u.searchParams.set("accept-language", opts.lang);
  return u.href;
}

const finite = (n: unknown): number | undefined => {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};
const inRange = (lat: number, lon: number) => Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** Antwort lesen (unbekannte/kaputte Einträge werden übersprungen, nie geraten). */
export function parseGeocode(cfg: GeocoderConfig, json: unknown): GeocodeHit[] {
  const out: GeocodeHit[] = [];
  if (cfg.kind === "photon") {
    const features = (json as { features?: unknown })?.features;
    if (!Array.isArray(features)) return out;
    for (const f of features) {
      const coords = (f as { geometry?: { coordinates?: unknown } })?.geometry?.coordinates;
      const p = ((f as { properties?: unknown })?.properties ?? {}) as Record<string, unknown>;
      if (!Array.isArray(coords)) continue;
      const lon = finite(coords[0]), lat = finite(coords[1]);
      if (lat === undefined || lon === undefined || !inRange(lat, lon)) continue;
      const str = (k: string) => (typeof p[k] === "string" && p[k] ? (p[k] as string) : undefined);
      const street = [str("street"), str("housenumber")].filter(Boolean).join(" ");
      const city = [str("postcode"), str("city") ?? str("town") ?? str("village")].filter(Boolean).join(" ");
      const address = [street, city, str("country")].filter(Boolean).join(", ");
      const name = str("name") ?? (street || city || address);
      if (!name) continue;
      out.push({ name, address: address || name, lat, lon });
    }
    return out;
  }
  if (!Array.isArray(json)) return out;
  for (const r of json as Record<string, unknown>[]) {
    const lat = finite(r?.lat), lon = finite(r?.lon);
    const display = typeof r?.display_name === "string" ? r.display_name : "";
    if (lat === undefined || lon === undefined || !inRange(lat, lon) || !display) continue;
    const name = typeof r.name === "string" && r.name ? r.name : display.split(",")[0]!.trim();
    out.push({ name, address: display, lat, lon });
  }
  return out;
}

/** „Look up address“: eine Anfrage an den eingestellten Dienst. Fehler mit verständlicher Meldung. */
export async function lookupAddress(fetcher: typeof fetch, cfg: GeocoderConfig, query: string, opts: { lang?: string; signal?: AbortSignal } = {}): Promise<GeocodeHit[]> {
  const url = geocodeURL(cfg, query, opts.lang ? { lang: opts.lang } : {});
  let res: Response;
  try {
    res = await fetcher(url, { headers: { Accept: "application/json" }, credentials: "omit", referrerPolicy: "no-referrer", ...(opts.signal ? { signal: opts.signal } : {}) });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    throw new Error("The address service can't be reached. Check your connection.");
  }
  if (res.status === 429) throw new Error("The address service is busy. Try again in a minute.");
  if (!res.ok) throw new Error(`The address service answered ${res.status}.`);
  let json: unknown;
  try { json = await res.json(); } catch { throw new Error("The address service sent something unreadable."); }
  return parseGeocode(cfg, json);
}

// MARK: Kacheln (Opt-in)

/** Kachel-Anbieter: Vorlage mit {z}/{x}/{y} (optional {s} für Subdomains a/b/c) und Pflicht-Hinweis. */
export interface TileConfig {
  template: string;
  attribution: string;
  maxZoom?: number;
}

/** Vorlage prüfen: https (localhost auch http), alle drei Platzhalter, ein Hinweis. Fehlerliste leer = gültig. */
export function validateTiles(cfg: TileConfig): string[] {
  const errors: string[] = [];
  try { httpsOnly(cfg.template.replace(/\{[a-z]\}/g, "0")); } catch (e) { errors.push(e instanceof Error ? e.message : "Invalid address."); }
  for (const p of ["{z}", "{x}", "{y}"]) if (!cfg.template.includes(p)) errors.push(`The address needs ${p}.`);
  if (!cfg.attribution.trim()) errors.push("Map tiles need the provider's attribution.");
  return errors;
}

/** Adresse einer Kachel. */
export function tileURL(cfg: TileConfig, z: number, x: number, y: number): string {
  const n = 2 ** z;
  const wx = ((x % n) + n) % n; // waagrecht umlaufend
  return cfg.template.replace("{z}", String(z)).replace("{x}", String(wx)).replace("{y}", String(y)).replace("{s}", "abc"[(wx + y) % 3]!);
}

/**
 * Sichtbare Kacheln für einen Ausschnitt in Weltpixeln bei Zoom `zoom` (Kachelgröße 256): ganzzahliger Kachel-Zoom,
 * Bereich der Kacheln, die den Ausschnitt überdecken (senkrecht abgeschnitten). Die Ansicht skaliert sie mit `scale`.
 */
export function visibleTiles(view: { cx: number; cy: number; zoom: number; width: number; height: number }, maxZoom = 19): { z: number; scale: number; tiles: { x: number; y: number }[] } {
  const z = Math.max(0, Math.min(maxZoom, Math.round(view.zoom)));
  const scale = 2 ** (view.zoom - z);
  const size = 256 * scale;
  const n = 2 ** z;
  // Mitte in Kachel-Koordinaten des ganzzahligen Zooms
  const cxTiles = view.cx / (256 * 2 ** view.zoom) * n, cyTiles = view.cy / (256 * 2 ** view.zoom) * n;
  const halfW = view.width / 2 / size, halfH = view.height / 2 / size;
  const x0 = Math.floor(cxTiles - halfW), x1 = Math.floor(cxTiles + halfW);
  const y0 = Math.max(0, Math.floor(cyTiles - halfH)), y1 = Math.min(n - 1, Math.floor(cyTiles + halfH));
  const tiles: { x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y });
  return { z, scale, tiles };
}
