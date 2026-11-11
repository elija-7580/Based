// BSD-238: Tastatur für Karten und Listenzeilen: Pfeile wandern zur Nachbarkarte, ⇧F10 / Menütaste öffnet das Zeilenmenü.
// Hängt als onKeyDown am Layout; die Geometrie rechnet logic/spatial.ts.
import type { KeyboardEvent } from "react";
import { directionOf, nearestInDirection } from "./logic/spatial.js";

// Teil 3: Kalender-Einträge und Timeline-Balken sind selbst fokussierbar (data-row-id + tabIndex).
const PRIMARY = ".dbui-card-open, .dbui-list-title, .dbui-cal-entry, .dbui-tl-bar";
const primaryOf = (el: HTMLElement) => (el.matches(PRIMARY) ? el : el.querySelector<HTMLElement>(PRIMARY));

export function cardKeys(e: KeyboardEvent<HTMLElement>) {
  const target = e.target as HTMLElement;
  const item = target.closest<HTMLElement>("[data-row-id]");
  if (!item || !e.currentTarget.contains(item)) return;
  if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
    const menu = item.querySelector<HTMLElement>(".dbui-card-menu, .dbui-row-handle");
    if (menu) {
      e.preventDefault();
      menu.click();
    }
    return;
  }
  const dir = directionOf(e.key);
  if (!dir || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !target.matches(PRIMARY)) return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row-id]")].filter((el) => el !== item && primaryOf(el));
  const rects = items.map((el) => el.getBoundingClientRect());
  let i = nearestInDirection(item.getBoundingClientRect(), rects, dir);
  // Timeline: ↑/↓ geht in die nächste Zeile, auch wenn der Balken dort zeitlich woanders liegt.
  if (i < 0 && target.matches(".dbui-tl-bar") && (dir === "up" || dir === "down")) i = nextRow(item.getBoundingClientRect(), rects, dir);
  const next = i >= 0 ? primaryOf(items[i]!) : null;
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Nächster Balken in der Zeile darüber/darunter (kleinster senkrechter, dann waagrechter Abstand). */
function nextRow(from: DOMRect, rects: readonly DOMRect[], dir: "up" | "down"): number {
  const cy = from.top + from.height / 2, cx = from.left + from.width / 2;
  let best = -1, bestDy = Infinity, bestDx = Infinity;
  rects.forEach((r, i) => {
    const dy = (r.top + r.height / 2 - cy) * (dir === "down" ? 1 : -1);
    if (dy <= 1) return;
    const dx = Math.abs(r.left + r.width / 2 - cx);
    if (dy < bestDy - 1 || (Math.abs(dy - bestDy) <= 1 && dx < bestDx)) { best = i; bestDy = dy; bestDx = dx; }
  });
  return best;
}
