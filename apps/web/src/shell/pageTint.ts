// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Elija 23.11.2026 („Farbe automatisch“): Seiten ohne eigenes Icon bekommen in der Seitenleiste eine farbige Kachel wie
// auf der Website. Die Farbe folgt aus der ID der Seite – nichts wird gespeichert, sie ist auf jedem Gerät dieselbe und
// bleibt beim Umbenennen. Kein Gelb: Gelb heißt „ein Agent hat hier gearbeitet“.

/** Anzahl der Kachelfarben (`.page-tile[data-tint="0…"]` in styles.css). */
export const PAGE_TINTS = 5;

/** Feste Kachelfarbe (0 … PAGE_TINTS − 1) für eine Seite. */
export function pageTint(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % PAGE_TINTS;
}
