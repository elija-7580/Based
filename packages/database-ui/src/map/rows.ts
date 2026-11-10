// Zeilen einer Kartenansicht: mit Koordinaten (Pins) und „ohne Ort“ (leer oder nur Text/Adresse).
import { valueCase, type Block } from "@based/core";
import { hasCoordinates, parsePlace, type Place } from "../logic/place.js";

export interface LocatedRow { row: Block; place: Place & { lat: number; lon: number } }
export interface UnlocatedRow { row: Block; place: Place; label: string }

export function mapRows(rows: readonly Block[], propertyID: string | undefined): { located: LocatedRow[]; unlocated: UnlocatedRow[] } {
  const located: LocatedRow[] = [], unlocated: UnlocatedRow[] = [];
  for (const row of rows) {
    const c = propertyID ? valueCase(row.values?.[propertyID]) : undefined;
    const place = c?.[0] === "place" && typeof c[1] === "string" ? parsePlace(c[1]) : {};
    if (hasCoordinates(place)) located.push({ row, place });
    else unlocated.push({ row, place, label: place.name ?? place.address ?? "" });
  }
  return { located, unlocated };
}
