// Based-Menü als schwebende Ebene: Kontextmenü (role=menu) und Auswahlliste (role=listbox). Der Fokus bleibt, wo er
// war (Textauswahl und Schreibmarke bleiben erhalten); Pfeile, Enter, Tippen und Escape steuern das Menü trotzdem.
import { openLayer, pointer, type Layer, type LayerAnchor } from "./layer.js";
import { isAction, nextEnabled, typeahead, type MenuEntry } from "./logic.js";

export interface MenuOptions {
  label?: string;
  role?: "menu" | "listbox";
  /** Eintrag, der beim Öffnen markiert ist (Auswahlliste: der gewählte). */
  active?: number;
  minWidthOfAnchor?: boolean;
  scrollWith?: Element;
  onClose?: () => void;
}

export function showMenu(entries: readonly MenuEntry[], anchor: LayerAnchor, opts: MenuOptions = {}): Layer {
  const role = opts.role ?? "menu";
  const el = document.createElement("div");
  el.className = "nf-menu";
  el.setAttribute("role", role);
  if (opts.label) el.setAttribute("aria-label", opts.label);
  const rows: (HTMLElement | undefined)[] = entries.map((e, i) => {
    if ("separator" in e) {
      const s = document.createElement("div");
      s.className = "nf-sep";
      s.setAttribute("role", "separator");
      el.appendChild(s);
      return undefined;
    }
    if ("heading" in e) {
      const h = document.createElement("div");
      h.className = "nf-heading";
      h.textContent = e.heading;
      el.appendChild(h);
      return undefined;
    }
    const row = document.createElement("div");
    row.className = "nf-item" + (e.danger ? " danger" : "");
    row.setAttribute("role", role === "menu" ? "menuitem" : "option");
    row.dataset.nfAct = String(i);
    if (e.disabled) row.setAttribute("aria-disabled", "true");
    if (role === "listbox") row.setAttribute("aria-selected", e.checked ? "true" : "false");
    const label = document.createElement("span");
    label.className = "nf-label";
    label.textContent = e.label;
    row.appendChild(label);
    if (e.hint) {
      const hint = document.createElement("span");
      hint.className = "nf-hint";
      hint.textContent = e.hint;
      row.appendChild(hint);
    }
    if (e.checked) {
      const check = document.createElement("span");
      check.className = "nf-check";
      check.setAttribute("aria-hidden", "true");
      row.appendChild(check);
    }
    el.appendChild(row);
    return row;
  });

  let active = -1;
  const setActive = (i: number, reveal = true) => {
    if (active >= 0) rows[active]?.removeAttribute("data-active");
    active = i;
    const row = i >= 0 ? rows[i] : undefined;
    if (!row) return;
    row.setAttribute("data-active", "");
    if (reveal) row.scrollIntoView?.({ block: "nearest" });
  };
  const run = (i: number) => {
    const e = entries[i];
    if (!e || !isAction(e) || e.disabled) return;
    layer.close();
    e.run();
  };
  // Erst echte Bewegung markiert: Öffnet sich das Menü per Tastatur unter dem ruhenden Zeiger, melden Browser trotzdem
  // Mausereignisse an derselben Stelle – die dürfen die Tastaturwahl nicht überschreiben.
  const rest = { x: pointer.x, y: pointer.y };
  el.addEventListener("mousemove", (ev) => {
    if (ev.clientX === rest.x && ev.clientY === rest.y) return;
    rest.x = rest.y = -1;
    const row = (ev.target as Element).closest<HTMLElement>("[data-nf-act]");
    if (row && row.getAttribute("aria-disabled") !== "true" && Number(row.dataset.nfAct) !== active) setActive(Number(row.dataset.nfAct), false);
  });
  el.addEventListener("mouseleave", () => { if (role === "menu") setActive(-1); });

  let typed = "";
  let typedAt = 0;
  const layer = openLayer(el, {
    anchor,
    ...(opts.minWidthOfAnchor ? { minWidthOfAnchor: true } : {}),
    ...(opts.scrollWith ? { scrollWith: opts.scrollWith } : {}),
    ...(opts.onClose ? { onClose: opts.onClose } : {}),
    onAct: (act) => run(Number(act)),
    onKey: (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      switch (e.key) {
        case "ArrowDown": setActive(nextEnabled(entries, active < 0 ? -1 : active, 1)); return true;
        case "ArrowUp": setActive(nextEnabled(entries, active < 0 ? 0 : active, -1)); return true;
        case "Home": setActive(nextEnabled(entries, -1, 1)); return true;
        case "End": setActive(nextEnabled(entries, 0, -1)); return true;
        case "Enter": if (active >= 0) run(active); else layer.close(); return true;
        case " ": if (typed && e.timeStamp - typedAt < 700) break; if (active >= 0) run(active); return true;
      }
      if (e.key.length === 1) {
        typed = e.timeStamp - typedAt < 700 ? typed + e.key : e.key;
        typedAt = e.timeStamp;
        const hit = typeahead(entries, typed, typed.length === 1 ? active + 1 : Math.max(active, 0));
        if (hit >= 0) setActive(hit);
        return true;
      }
      return false;
    },
  });
  if (opts.active !== undefined && opts.active >= 0) setActive(opts.active);
  return layer;
}
