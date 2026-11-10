// Ort einer Place-Property (Swift `PlaceValue`): JSON `{"name","address","lat","lon"}` sobald Koordinaten oder eine
// Adresse da sind, sonst der reine Name (lesbar, kompatibel mit älteren Daten). Kein Geocoding: Koordinaten gibt
// man von Hand ein.

export interface Place {
  name?: string;
  address?: string;
  lat?: number;
  lon?: number;
  /** Unbekannte Felder (z. B. `google_place_id`) bleiben beim Bearbeiten erhalten. */
  extra?: Record<string, unknown>;
}

const blank = (s: unknown): string | undefined => (typeof s === "string" && s.trim() ? s : undefined);
const num = (n: unknown): number | undefined => (typeof n === "number" && Number.isFinite(n) ? n : undefined);

/** Gespeicherten Wert lesen (Swift `PlaceValue(raw:)`). */
export function parsePlace(raw: string | undefined): Place {
  const t = (raw ?? "").trim();
  if (!t) return {};
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      if (j && typeof j === "object" && !Array.isArray(j)) {
        const { name, address, lat, lon, ...extra } = j;
        const p: Place = {};
        const n = blank(name), a = blank(address), la = num(lat), lo = num(lon);
        if (n) p.name = n;
        if (a) p.address = a;
        if (la !== undefined) p.lat = la;
        if (lo !== undefined) p.lon = lo;
        if (Object.keys(extra).length) p.extra = extra;
        return p;
      }
    } catch { /* kein JSON: wie Text */ }
  }
  const parts = t.split(",").map((s) => s.trim());
  if (parts.length === 2 && parts.every((s) => /^[-+]?\d+(\.\d+)?$/.test(s))) {
    const a = Number(parts[0]), b = Number(parts[1]);
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lon: b };
  }
  return { name: t };
}

/** Swift `PlaceValue.hasCoordinates`: beide da, im Bereich und nicht genau 0/0. */
export function hasCoordinates(p: Place): p is Place & { lat: number; lon: number } {
  return p.lat !== undefined && p.lon !== undefined && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && !(p.lat === 0 && p.lon === 0);
}

/** Speicherform (Swift `PlaceValue.raw`, Schlüssel sortiert); `undefined` = leer. */
export function encodePlace(p: Place): string | undefined {
  const name = blank(p.name)?.trim(), address = blank(p.address)?.trim();
  const coords = p.lat !== undefined && p.lon !== undefined;
  const extra = p.extra ?? {};
  if (!coords && !address && Object.keys(extra).length === 0) return name;
  const o: Record<string, unknown> = { ...extra };
  if (address) o.address = address;
  if (coords) { o.lat = p.lat; o.lon = p.lon; }
  if (name) o.name = name;
  return JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** Koordinate aus einer Eingabe („48,2“, „ 16.37 “); `undefined` = leer, `NaN` = keine Zahl. */
export function parseCoordinate(s: string | undefined): number | undefined {
  const t = s?.trim().replace(",", ".") ?? "";
  if (!t) return undefined;
  return /^[-+]?\d+(\.\d+)?$|^[-+]?\.\d+$/.test(t) ? Number(t) : NaN;
}

/** Fehler der Koordinaten-Eingaben, sonst `undefined`. */
export function coordinateError(lat: string | undefined, lon: string | undefined): string | undefined {
  const a = parseCoordinate(lat), b = parseCoordinate(lon);
  if ((a === undefined) !== (b === undefined)) return "Enter both latitude and longitude";
  if (Number.isNaN(a) || Number.isNaN(b)) return "Coordinates must be numbers";
  if (a !== undefined && (a < -90 || a > 90)) return "Latitude must be between −90 and 90";
  if (b !== undefined && (b < -180 || b > 180)) return "Longitude must be between −180 and 180";
  return undefined;
}
