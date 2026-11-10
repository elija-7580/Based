// BSD-160 / BSD-196 (Aktion schedule): menschenlesbare Zeitpläne wie in Swift `Schedule` (BasedBrain/Agent/Scheduler.swift):
// „every 15m“, „every 2h“, „hourly“, „daily 07:30“, „weekdays 18:00“, „weekly mon,thu 09:00“, „monthly 1 08:00“ und
// einmalig „2026-11-12 09:00“ / „2026-11-12“. Lokale Zeit. Rein (Uhr kommt von außen).

export type ScheduleKind =
  | { kind: "every"; ms: number }
  | { kind: "daily"; hour: number; minute: number; weekdays?: number[] }
  | { kind: "monthly"; day: number; hour: number; minute: number }
  | { kind: "once"; at: number };

export interface Schedule {
  source: string;
  rule: ScheduleKind;
}

const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function hm(t: string | undefined): [number, number] | undefined {
  if (!t) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return undefined;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? [h, min] : undefined;
}

export function parseSchedule(raw: string): Schedule | undefined {
  const source = raw.trim();
  const s = source.toLowerCase().replace(/\s+/g, " ");
  if (!s) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2}))?$/.exec(s);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), iso[4] ? Number(iso[4]) : 9, iso[5] ? Number(iso[5]) : 0);
    return Number.isNaN(d.getTime()) || d.getMonth() !== Number(iso[2]) - 1 ? undefined : { source, rule: { kind: "once", at: d.getTime() } };
  }
  const parts = s.split(" ");
  switch (parts[0]) {
    case "hourly": return { source, rule: { kind: "every", ms: 3_600_000 } };
    case "every": {
      const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hours?|d|days?)$/.exec(parts.slice(1).join(" "));
      if (!m) return undefined;
      const n = Number(m[1]);
      const unit = m[2]!.startsWith("m") ? 60_000 : m[2]!.startsWith("h") ? 3_600_000 : 86_400_000;
      // unter 5 Minuten nicht (Doppel-Läufe, Kosten)
      return n * unit >= 300_000 ? { source, rule: { kind: "every", ms: n * unit } } : undefined;
    }
    case "daily": {
      const t = parts.length > 1 ? hm(parts[1]) : [9, 0] as [number, number];
      return t ? { source, rule: { kind: "daily", hour: t[0], minute: t[1] } } : undefined;
    }
    case "weekdays": {
      const t = parts.length > 1 ? hm(parts[1]) : [9, 0] as [number, number];
      return t ? { source, rule: { kind: "daily", hour: t[0], minute: t[1], weekdays: [1, 2, 3, 4, 5] } } : undefined;
    }
    case "weekly": {
      const days = (parts[1] ?? "").split(",").map((d) => DAYS[d.slice(0, 3)]).filter((d): d is number => d !== undefined);
      const t = parts.length > 2 ? hm(parts[2]) : [9, 0] as [number, number];
      return days.length > 0 && t ? { source, rule: { kind: "daily", hour: t[0], minute: t[1], weekdays: [...new Set(days)].sort() } } : undefined;
    }
    case "monthly": {
      const day = Number(parts[1]);
      const t = parts.length > 2 ? hm(parts[2]) : [9, 0] as [number, number];
      return Number.isInteger(day) && day >= 1 && day <= 31 && t ? { source, rule: { kind: "monthly", day, hour: t[0], minute: t[1] } } : undefined;
    }
  }
  return undefined;
}

/** Nächster Termin nach `after` (ms). `undefined`: einmaliger Termin liegt davor. */
export function nextFire(s: Schedule, after: number): number | undefined {
  const r = s.rule;
  switch (r.kind) {
    case "once": return r.at > after ? r.at : undefined;
    case "every": return after + r.ms;
    case "daily": {
      const d = new Date(after);
      d.setSeconds(0, 0);
      d.setHours(r.hour, r.minute);
      for (let i = 0; i < 8; i++) {
        if (d.getTime() > after && (!r.weekdays || r.weekdays.includes(d.getDay()))) return d.getTime();
        d.setDate(d.getDate() + 1);
        d.setHours(r.hour, r.minute);
      }
      return undefined;
    }
    case "monthly": {
      const d = new Date(after);
      for (let i = 0; i < 24; i++) {
        const c = new Date(d.getFullYear(), d.getMonth() + i, r.day, r.hour, r.minute);
        // 31. in kurzen Monaten: überspringen
        if (c.getDate() === r.day && c.getTime() > after) return c.getTime();
      }
      return undefined;
    }
  }
}

/** „23:00“, „Mon 09:00“, „12 Nov 09:00“ für Pillen. */
export function formatFire(ms: number, now: number): string {
  const d = new Date(ms);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return time;
  if (ms - now < 6 * 86_400_000) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${time}`;
  return `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${time}`;
}
