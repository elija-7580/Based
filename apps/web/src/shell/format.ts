// Zeiten für die Oberfläche. Records speichern Swift-Daten (Sekunden seit 2001-01-01).
const SWIFT_EPOCH_MS = 978_307_200_000;

export const fromSwift = (t: number) => new Date(SWIFT_EPOCH_MS + t * 1000);

/** „just now“, „5 min“, „3 h“, „Yesterday“, sonst ein Datum. */
export function relative(when: Date, now = new Date()): string {
  const s = (now.getTime() - when.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400 && now.getDate() === when.getDate()) return `${Math.floor(s / 3600)} h`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (y.toDateString() === when.toDateString()) return "Yesterday";
  return when.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(when.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

export const longDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
