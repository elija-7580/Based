// Icons der Datenbank-Hüllen (Peek, Formular, Karte): Linien auf 24-px-Raster, 2 px, runde Enden.
const P = {
  up: "M6 15l6-6 6 6",
  down: "M6 9l6 6 6-6",
  expand: "M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7",
  check: "M5 12.5l4.5 4.5L19 7.5",
} as const;

export function DbIcon({ name, size = 16 }: { name: keyof typeof P; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
      <path d={P[name]} />
    </svg>
  );
}
