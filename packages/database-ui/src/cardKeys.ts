// BSD-238: Tastatur für Karten und Listenzeilen: Pfeile wandern zur Nachbarkarte, ⇧F10 / Menütaste öffnet das Zeilenmenü.
// Hängt als onKeyDown am Layout; die Geometrie rechnet logic/spatial.ts.
import type { KeyboardEvent } from "react";
import { directionOf, nearestInDirection } from "./logic/spatial.js";

const PRIMARY = ".dbui-card-open, .dbui-list-title";

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
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-row-id]")].filter((el) => el !== item && el.querySelector(PRIMARY));
  const i = nearestInDirection(item.getBoundingClientRect(), items.map((el) => el.getBoundingClientRect()), dir);
  const next = i >= 0 ? items[i]!.querySelector<HTMLElement>(PRIMARY) : null;
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.scrollIntoView({ block: "nearest", inline: "nearest" });
}
