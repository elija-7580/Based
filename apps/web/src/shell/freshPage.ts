// BSD-482: Eine eben angelegte Seite bekommt die Schreibmarke im Titel (wie Notion) – nur beim ersten Zeigen dieser
// Seite, damit normales Öffnen (Seitenleiste, ⌘K, Zurück) keinen Fokus stiehlt.

let pending: string | undefined;

/** Neue Seite vormerken: Das Titelfeld dieser Seite holt sich beim ersten Zeigen den Fokus. */
export function markFreshPage(id: string): void {
  pending = id;
}

/** Ist diese Seite gerade neu angelegt? Gibt einmal `true` und vergisst sie dann. */
export function takeFreshPage(id: string): boolean {
  if (pending !== id) return false;
  pending = undefined;
  return true;
}
