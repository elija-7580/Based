// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// Feedback 20. 11. („muss ein paar Mal draufdrücken“): WebKit beginnt bei ziehbaren Elementen (`draggable`) schon nach
// rund 3 px Bewegung eine native Ziehbewegung. Ein Klick mit leichtem Zittern auf dem Trackpad wurde so zum Ziehen auf
// die Stelle selbst – und der Klick ging verloren (Seitenleiste: Seiten, Search, Home …). Wer ein ziehbares Element
// nur ein paar Pixel bewegt und an derselben Stelle loslässt, hat geklickt.

/** Bis zu dieser Strecke (px) zwischen Beginn des Ziehens und Loslassen zählt ein „Ziehen“ auf sich selbst als Klick. */
export const CLICK_SLOP_PX = 10;

let press: { x: number; y: number } | undefined;

/**
 * Bei `dragstart` den Ausgangspunkt merken. Nicht bei pointerdown: nach einer Ziehbewegung meldet WebKit das nächste
 * Drücken nicht als pointerdown (der Punkt wäre dann alt).
 */
export function noteDragStart(e: { clientX: number; clientY: number }): void {
  press = { x: e.clientX, y: e.clientY };
}

/** War das Loslassen (drop) nah genug am Beginn des Ziehens, um als Klick zu gelten? */
export function releasedAsClick(e: { clientX: number; clientY: number }, from: { x: number; y: number } | undefined = press): boolean {
  if (!from) return false;
  return Math.hypot(e.clientX - from.x, e.clientY - from.y) <= CLICK_SLOP_PX;
}
