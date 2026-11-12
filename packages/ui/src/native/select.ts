// Jedes <select> der App (auch aus fremden Bausteinen wie dem Code-Block des Editors) öffnet statt der Systemliste
// die Based-Auswahlliste. Das Feld selbst bleibt ein <select> (Wert, Formular, Screenreader, Tests); gewählt wird
// über selectedIndex + input/change, so wie es der Browser auch meldet.
import { showMenu } from "./menu.js";
import { hasLayers, type Layer } from "./layer.js";
import type { MenuEntry } from "./logic.js";

let current: { select: HTMLSelectElement; layer: Layer } | undefined;

/** Einträge der Liste in Dokumentreihenfolge; `<optgroup>` wird Überschrift. `index` zeigt auf select.options. */
export function selectEntries(select: HTMLSelectElement, choose: (index: number) => void): { entries: MenuEntry[]; active: number } {
  const entries: MenuEntry[] = [];
  let active = -1;
  const options = [...select.options];
  const add = (o: HTMLOptionElement, groupDisabled: boolean) => {
    if (o.hidden) return;
    const index = options.indexOf(o);
    if (o.selected) active = entries.length;
    entries.push({ label: o.label || o.text, disabled: o.disabled || groupDisabled, checked: o.selected, run: () => choose(index) });
  };
  for (const child of select.children) {
    if (child instanceof HTMLOptGroupElement) {
      entries.push({ heading: child.label });
      for (const o of child.children) if (o instanceof HTMLOptionElement) add(o, child.disabled);
    } else if (child instanceof HTMLOptionElement) add(child, false);
  }
  return { entries, active };
}

function choose(select: HTMLSelectElement, index: number) {
  if (select.selectedIndex === index) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

export function openSelect(select: HTMLSelectElement) {
  current?.layer.close();
  const { entries, active } = selectEntries(select, (i) => choose(select, i));
  if (!entries.length) return;
  const label = select.getAttribute("aria-label") ?? select.labels?.[0]?.textContent?.trim() ?? undefined;
  select.setAttribute("aria-expanded", "true");
  const layer = showMenu(entries, select, {
    role: "listbox", active, minWidthOfAnchor: true, ...(label ? { label } : {}),
    onClose: () => { select.removeAttribute("aria-expanded"); if (current?.select === select) current = undefined; },
  });
  current = { select, layer };
}

const plain = (t: EventTarget | null): HTMLSelectElement | undefined => {
  const s = t instanceof Element ? t.closest("select") : null;
  return s && !s.disabled && !s.multiple && s.size <= 1 ? s : undefined;
};

/** Fängt Maus und Tasten ab, die sonst die Systemliste öffnen würden. Liefert die Funktion zum Abbauen. */
export function installSelects(target: Window = window): () => void {
  const onDown = (e: MouseEvent) => {
    const select = plain(e.target);
    if (!select || e.button !== 0) return;
    e.preventDefault();
    if (current?.select === select) { current.layer.close(); return; }
    select.focus({ preventScroll: true });
    openSelect(select);
  };
  const onKey = (e: KeyboardEvent) => {
    const select = plain(e.target);
    // Liegt schon eine Ebene offen (diese Liste, ein Kontextmenü), gehören die Tasten ihr.
    // Auch nicht, wenn die Ebene die Taste gerade verbraucht hat (Enter wählt und schließt – nicht gleich wieder öffnen).
    if (!select || e.defaultPrevented || hasLayers() || e.metaKey || e.ctrlKey) return;
    if (![" ", "Enter", "ArrowDown", "ArrowUp", "F4"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    openSelect(select);
  };
  target.addEventListener("mousedown", onDown, true);
  target.addEventListener("keydown", onKey, true);
  return () => {
    target.removeEventListener("mousedown", onDown, true);
    target.removeEventListener("keydown", onKey, true);
  };
}
