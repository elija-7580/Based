// Based-Kalender und Uhrzeitliste als schwebende Ebene – Ersatz für die Systemauswahl von <input type="date|time">.
import { openLayer, type Layer } from "./layer.js";
import { showMenu } from "./menu.js";
import { isoDay, monthGrid, parseDay, shiftDay, shiftMonth, timeSlots } from "./logic.js";

function today(): string {
  const d = new Date();
  return isoDay(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function weekStart(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    if (first !== undefined) return first % 7;
  } catch { /* unbekannte Sprache */ }
  return 1;
}

const utc = (iso: string) => { const [y, m, d] = iso.split("-").map(Number) as [number, number, number]; const x = new Date(Date.UTC(2000, m - 1, d)); x.setUTCFullYear(y); return x; };

export interface CalendarOptions { value: string; onPick: (iso: string) => void; onClose?: () => void }

export function openCalendar(anchor: Element, opts: CalendarOptions): Layer {
  const start = weekStart();
  const now = today();
  let cursor = parseDay(opts.value) ?? now;
  const selected = parseDay(opts.value);
  const el = document.createElement("div");
  el.className = "nf-cal";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Choose a date");
  const monthName = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
  const dayName = new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" });
  const full = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeZone: "UTC" });

  const button = (cls: string, act: string, label: string, text: string) => {
    const b = document.createElement("div");
    b.className = cls;
    b.setAttribute("role", "button");
    b.dataset.nfAct = act;
    b.setAttribute("aria-label", label);
    b.textContent = text;
    return b;
  };
  const render = () => {
    const [y, m] = cursor.split("-").map(Number) as [number, number];
    el.textContent = "";
    const head = document.createElement("div");
    head.className = "nf-cal-head";
    const title = document.createElement("span");
    title.className = "nf-cal-title";
    title.setAttribute("aria-live", "polite");
    title.textContent = monthName.format(utc(isoDay(y, m, 1)));
    head.append(title, button("nf-cal-nav", "today", "Today", "Today"), button("nf-cal-nav nf-cal-arrow", "prev", "Previous month", "‹"), button("nf-cal-nav nf-cal-arrow", "next", "Next month", "›"));
    const grid = document.createElement("div");
    grid.className = "nf-cal-grid";
    const cells = monthGrid(y, m, start);
    for (const c of cells.slice(0, 7)) {
      const w = document.createElement("span");
      w.className = "nf-cal-weekday";
      w.setAttribute("aria-hidden", "true");
      w.textContent = dayName.format(utc(c.iso)).slice(0, 2);
      grid.appendChild(w);
    }
    for (const c of cells) {
      const d = button("nf-cal-day", `day:${c.iso}`, full.format(utc(c.iso)), String(c.day));
      if (!c.inMonth) d.classList.add("out");
      if (c.iso === now) d.classList.add("today");
      if (c.iso === selected) d.setAttribute("aria-pressed", "true");
      if (c.iso === cursor) d.setAttribute("data-active", "");
      grid.appendChild(d);
    }
    el.append(head, grid);
  };
  const move = (iso: string) => { cursor = iso; render(); };
  const pick = (iso: string) => { layer.close(); opts.onPick(iso); };
  render();
  const layer = openLayer(el, {
    anchor,
    ...(opts.onClose ? { onClose: opts.onClose } : {}),
    onAct: (act) => {
      if (act === "prev") move(shiftMonth(cursor, -1));
      else if (act === "next") move(shiftMonth(cursor, 1));
      else if (act === "today") pick(now);
      else if (act.startsWith("day:")) pick(act.slice(4));
    },
    // Links/rechts bleiben beim Textfeld (Schreibmarke); mit ⌥ wandern sie tageweise.
    onKey: (e) => {
      if (e.metaKey || e.ctrlKey) return false;
      switch (e.key) {
        case "ArrowDown": move(shiftDay(cursor, 7)); return true;
        case "ArrowUp": move(shiftDay(cursor, -7)); return true;
        case "ArrowRight": if (!e.altKey) return false; move(shiftDay(cursor, 1)); return true;
        case "ArrowLeft": if (!e.altKey) return false; move(shiftDay(cursor, -1)); return true;
        case "PageDown": move(shiftMonth(cursor, 1)); return true;
        case "PageUp": move(shiftMonth(cursor, -1)); return true;
        case "Enter": pick(cursor); return true;
      }
      return false;
    },
  });
  return layer;
}

export function openTimeList(anchor: Element, opts: { value: string; onPick: (time: string) => void; onClose?: () => void }): Layer {
  const slots = timeSlots(30);
  const active = slots.findIndex((s) => s >= opts.value);
  return showMenu(slots.map((s) => ({ label: s, checked: s === opts.value, run: () => opts.onPick(s) })), anchor, {
    role: "listbox", label: "Choose a time", active: active < 0 ? 0 : active, minWidthOfAnchor: true, ...(opts.onClose ? { onClose: opts.onClose } : {}),
  });
}
