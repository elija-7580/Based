// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-657: Ist gerade ein Menü (oder Dialog, Liste) offen, das Esc zuerst schließen soll? Astryx lässt geschlossene
// Dropdowns in einem [popover] im DOM – die zählen nicht (`:popover-open`). WebKit vor 17 (macOS 13 mit Safari 16)
// kennt `:popover-open` nicht, dort wirft querySelector einen SyntaxError; dann zählt ein Popover als offen, solange es gezeichnet wird.

type Queryable = Pick<ParentNode, "querySelector" | "querySelectorAll">;

const CLOSED_POPOVER = ":not([popover]:not(:popover-open) *)";

/** Ohne `:popover-open`: ein Popover gilt als offen, solange es gezeichnet wird (geschlossen = display: none). */
const shown = (el: Element): boolean => {
  const pop = el.closest("[popover]");
  return !pop || pop.getClientRects().length > 0;
};

/**
 * Erstes offenes Element zu `roles` (z. B. "[role=menu], [role=dialog]"), Elemente in geschlossenen Popovers
 * ausgenommen; `extra` sind weitere Selektoren ohne diesen Filter.
 */
export function openOverlay(root: Queryable, roles: string, extra?: string): Element | null {
  try {
    return root.querySelector(`:is(${roles})${CLOSED_POPOVER}${extra ? `, ${extra}` : ""}`);
  } catch {
    for (const el of Array.from(root.querySelectorAll(roles))) if (shown(el)) return el;
    return extra ? root.querySelector(extra) : null;
  }
}
