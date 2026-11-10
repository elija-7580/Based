// Place-Property von Hand: Name, Adresse, Breite/Länge (kein Geocoding, kein fremder Server). Übernommen wird beim
// Schließen bzw. mit Enter, wenn die Koordinaten stimmen; unbekannte Felder (z. B. google_place_id) bleiben.
import { useRef, useState } from "react";
import { pv, setValue, valueCase } from "@based/core";
import { useDB } from "../context.js";
import { coordinateError, encodePlace, parseCoordinate, parsePlace } from "../logic/place.js";
import { Popover } from "../ui.js";
import type { CellEditorProps } from "./CellEditor.js";

export function PlaceEditor({ row, prop, anchor, onClose }: CellEditorProps) {
  const { store } = useDB();
  const c = valueCase(row.values?.[prop.id]);
  const stored = c?.[0] === "place" && typeof c[1] === "string" ? c[1] : "";
  const initial = parsePlace(stored);
  const [f, setF] = useState({
    name: initial.name ?? "", address: initial.address ?? "",
    lat: initial.lat !== undefined ? String(initial.lat) : "", lon: initial.lon !== undefined ? String(initial.lon) : "",
  });
  const [error, setError] = useState<string | undefined>();
  const done = useRef(false);
  const commit = (): boolean => {
    if (done.current) return true;
    const e = coordinateError(f.lat, f.lon);
    if (e) { setError(e); return false; }
    done.current = true;
    const lat = parseCoordinate(f.lat), lon = parseCoordinate(f.lon);
    const raw = encodePlace({
      ...(f.name.trim() ? { name: f.name } : {}), ...(f.address.trim() ? { address: f.address } : {}),
      ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}), ...(initial.extra ? { extra: initial.extra } : {}),
    });
    if ((raw ?? "") !== stored) setValue(store, row.id, prop.id, raw === undefined ? null : pv("place", raw));
    return true;
  };
  const field = (key: keyof typeof f, label: string, extra: Record<string, string> = {}) => (
    <label className="dbui-field">
      <span className="dbui-field-label">{label}</span>
      <input className={"dbui-input" + (error && (key === "lat" || key === "lon") ? " invalid" : "")} aria-label={label} value={f[key]} {...extra}
        onChange={(e) => { setF({ ...f, [key]: e.target.value }); setError(undefined); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (commit()) onClose(); } }} />
    </label>
  );
  return (
    <Popover anchor={anchor} onClose={() => { if (commit()) onClose(); else { done.current = true; onClose(); } }} className="dbui-place-editor" label={`Edit ${prop.name}`}>
      {field("name", "Name")}
      {field("address", "Address")}
      <div className="dbui-place-coords">
        {field("lat", "Latitude", { inputMode: "decimal", placeholder: "48.2082" })}
        {field("lon", "Longitude", { inputMode: "decimal", placeholder: "16.3738" })}
      </div>
      {error ? <p className="dbui-hint danger" role="alert">{error}</p> : <p className="dbui-hint">Coordinates put the page on map views. Based doesn’t look up addresses.</p>}
    </Popover>
  );
}
