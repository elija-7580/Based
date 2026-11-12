// Reine Rechnung für die Based-eigenen Ersatzteile nativer Bedienelemente (Kontextmenü, Auswahlliste, Kalender,
// Tooltip). Ohne DOM, damit alles in Unit-Tests prüfbar bleibt; das DOM dazu steht in den Nachbardateien.

export interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
export interface Size { width: number; height: number }

/** Abstand zum Fensterrand, den ein schwebendes Element immer hält. */
export const EDGE = 8;

/**
 * Platz für ein schwebendes Element: unter dem Anker (oder am Punkt), linksbündig; passt es nicht, darüber bzw. nach
 * links geschoben. `center` setzt es mittig unter den Anker (Tooltips).
 */
export function place(anchor: Box, size: Size, view: Size, opts: { gap?: number; center?: boolean } = {}): { left: number; top: number; above: boolean } {
  const gap = opts.gap ?? 4;
  let top = anchor.bottom + gap;
  let above = false;
  if (top + size.height > view.height - EDGE) {
    const up = anchor.top - gap - size.height;
    if (up >= EDGE) { top = up; above = true; } else top = Math.max(EDGE, view.height - EDGE - size.height);
  }
  let left = opts.center ? anchor.left + anchor.width / 2 - size.width / 2 : anchor.left;
  if (left + size.width > view.width - EDGE) left = view.width - EDGE - size.width;
  if (left < EDGE) left = EDGE;
  return { left: Math.round(left), top: Math.round(top), above };
}

export const pointBox = (x: number, y: number): Box => ({ left: x, top: y, right: x, bottom: y, width: 0, height: 0 });

// MARK: Menüs

export type MenuEntry =
  | { label: string; hint?: string; disabled?: boolean; danger?: boolean; checked?: boolean; run: () => void }
  | { separator: true }
  | { heading: string };

export const isAction = (e: MenuEntry): e is Extract<MenuEntry, { label: string }> => "label" in e;

/** Trenner am Rand und doppelte Trenner fallen weg (Einträge kommen aus mehreren Quellen). */
export function tidyEntries(entries: readonly MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if ("separator" in e && (out.length === 0 || "separator" in out[out.length - 1]!)) continue;
    out.push(e);
  }
  while (out.length && "separator" in out[out.length - 1]!) out.pop();
  return out;
}

/** Nächster wählbarer Eintrag ab `from` in Richtung `step` (läuft um); -1, wenn es keinen gibt. */
export function nextEnabled(entries: readonly MenuEntry[], from: number, step: 1 | -1): number {
  const n = entries.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    const e = entries[i]!;
    if (isAction(e) && !e.disabled) return i;
  }
  return -1;
}

/** Tippen im offenen Menü: erster wählbarer Eintrag hinter `from`, der mit dem Getippten beginnt. */
export function typeahead(entries: readonly MenuEntry[], typed: string, from: number): number {
  const q = typed.toLocaleLowerCase();
  if (!q) return -1;
  const n = entries.length;
  for (let k = 0; k < n; k++) {
    const i = (((from + k) % n) + n) % n;
    const e = entries[i]!;
    if (isAction(e) && !e.disabled && e.label.toLocaleLowerCase().startsWith(q)) return i;
  }
  return -1;
}

// MARK: Kontextmenü

export interface TextContext {
  /** Feld oder bearbeitbarer Bereich unter dem Zeiger. */
  editable: boolean;
  /** Passwortfeld: weder ausschneiden noch kopieren. */
  secret: boolean;
  readOnly: boolean;
  hasSelection: boolean;
  link: boolean;
}

export type TextAction = "openLink" | "copyLink" | "cut" | "copy" | "paste" | "selectAll";

/** Welche Text-Einträge das Kontextmenü an dieser Stelle zeigt (in dieser Reihenfolge; "-" = Trenner). */
export function textActions(c: TextContext): { id: TextAction | "-"; disabled?: boolean }[] {
  const out: { id: TextAction | "-"; disabled?: boolean }[] = [];
  if (c.link) out.push({ id: "openLink" }, { id: "copyLink" }, { id: "-" });
  if (c.editable) {
    const noCopy = !c.hasSelection || c.secret;
    out.push({ id: "cut", disabled: noCopy || c.readOnly }, { id: "copy", disabled: noCopy }, { id: "paste", disabled: c.readOnly }, { id: "-" }, { id: "selectAll" });
  } else if (c.hasSelection) out.push({ id: "copy" });
  return out;
}

// MARK: Kalender

const pad = (n: number) => String(n).padStart(2, "0");
export const isoDay = (y: number, m: number, d: number) => `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`;

/** „2026-11-12“ oder „12.11.2026“ → ISO-Tag; alles andere (auch der 31.02.) → undefined. */
export function parseDay(text: string): string | undefined {
  const t = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t))) [y, mo, d] = [Number(m[3]), Number(m[2]), Number(m[1])];
  else return undefined;
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return undefined;
  const date = new Date(Date.UTC(2000, mo - 1, d));
  date.setUTCFullYear(y);
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return undefined;
  return isoDay(y, mo, d);
}

/** „9:5“ → undefined, „9:05“/„09:05“ → „09:05“. */
export function parseTime(text: string): string | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const h = Number(m[1]), min = Number(m[2]);
  return h > 23 || min > 59 ? undefined : `${pad(h)}:${pad(min)}`;
}

/** Tag um `days` verschieben (ISO rein, ISO raus). */
export function shiftDay(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(2000, m - 1, d + days));
  date.setUTCFullYear(y + (date.getUTCFullYear() - 2000));
  return isoDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Monat verschieben; der Tag wird aufs Monatsende gekürzt (31.01. + 1 → 28./29.02.). */
export function shiftMonth(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12), nm = (total % 12 + 12) % 12 + 1;
  return isoDay(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function daysInMonth(y: number, m: number): number {
  const date = new Date(Date.UTC(2000, m, 0));
  date.setUTCFullYear(y, m, 0);
  return date.getUTCDate();
}

export interface DayCell { iso: string; day: number; inMonth: boolean }

/** Sechs Wochen ab dem Wochenanfang (0 = Sonntag … 6 = Samstag) vor dem Monatsersten. */
export function monthGrid(y: number, m: number, weekStart: number): DayCell[] {
  const first = new Date(Date.UTC(2000, m - 1, 1));
  first.setUTCFullYear(y);
  const lead = (first.getUTCDay() - weekStart + 7) % 7;
  const start = shiftDay(isoDay(y, m, 1), -lead);
  return Array.from({ length: 42 }, (_, i) => {
    const iso = shiftDay(start, i);
    const [, mm, dd] = iso.split("-").map(Number) as [number, number, number];
    return { iso, day: dd, inMonth: mm === m };
  });
}

/** Uhrzeiten für die Auswahlliste (alle `step` Minuten). */
export function timeSlots(step = 30): string[] {
  const out: string[] = [];
  for (let t = 0; t < 24 * 60; t += step) out.push(`${pad(Math.floor(t / 60))}:${pad(t % 60)}`);
  return out;
}

// MARK: Tooltip

export interface TipSource { title: string; tag: string; hasLabel: boolean; hasText: boolean; isField: boolean; hasFieldLabel: boolean }

/**
 * Was aus einem `title` wird: der Text wandert nach `data-tip` (Based-Tooltip statt Systemblase). Trug der Titel den
 * zugänglichen Namen (Icon-Knopf ohne Text und ohne aria-label), wird er `aria-label`, sonst Beschreibung.
 */
export function tipPlan(s: TipSource): { tip: string; label?: string; description?: string } | undefined {
  const tip = s.title.trim();
  if (!tip || s.tag === "iframe") return undefined;
  if (s.hasLabel) return { tip, description: tip };
  const named = s.isField ? s.hasFieldLabel : s.hasText;
  return named ? { tip, description: tip } : { tip, label: tip };
}
