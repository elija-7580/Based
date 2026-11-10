// Icons für Astryx-Komponenten im Based-Stil (24-px-Raster, 2 px Strich, runde Enden) – ersetzt die Lucide-Icons
// des neutralen Themes, damit nichts Fremdes mitkommt. Größe 1em: Astryx setzt sie über die Schriftgröße.
import type { ReactNode } from "react";

const PATHS = {
  close: "M6 6l12 12M18 6 6 18",
  chevronDown: "M7 10l5 5 5-5",
  chevronLeft: "M14 7l-5 5 5 5",
  chevronRight: "M10 7l5 5-5 5",
  chevronsLeft: "M12 7l-5 5 5 5M18 7l-5 5 5 5",
  chevronsRight: "M6 7l5 5-5 5M12 7l5 5-5 5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  success: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM8.5 12.5l2.5 2.5 4.5-5",
  error: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM9.5 9.5l5 5M14.5 9.5l-5 5",
  warning: "M12 4.5 20.5 19h-17zM12 10v4M12 16.5h.01",
  info: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 11v5M12 8h.01",
  calendar: "M5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5zM4 10h16M8 3v4M16 3v4",
  clock: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4l2.5 2.5",
  externalLink: "M13 5h6v6M19 5l-8 8M10 6H6.5A1.5 1.5 0 0 0 5 7.5v10A1.5 1.5 0 0 0 6.5 19h10a1.5 1.5 0 0 0 1.5-1.5V14",
  menu: "M4 8h16M4 16h10",
  moreHorizontal: "M6 12h.01M12 12h.01M18 12h.01",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.6-4.6",
  upload: "M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  arrowsUpDown: "M8 20V5M4 9l4-4 4 4M16 4v15M12 15l4 4 4-4",
  funnel: "M4 5.5h16l-6 7.5v5l-4 2v-7z",
  eyeSlash: "M4 4l16 16M9.9 6.3A9 9 0 0 1 12 6c5 0 8.5 6 8.5 6a14 14 0 0 1-2.6 3.2M6.3 8.2A14 14 0 0 0 3.5 12S7 18 12 18a8 8 0 0 0 3.3-.7M10 10.2a2.8 2.8 0 0 0 3.8 3.8",
  viewColumns: "M5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11A1.5 1.5 0 0 1 5.5 5zM9.5 5v14M14.5 5v14",
  copy: "M10 8.5h8A1.5 1.5 0 0 1 19.5 10v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 8.5 18v-8A1.5 1.5 0 0 1 10 8.5zM15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5",
  checkDouble: "M3 12.5l4 4 8-9M11 15l1.5 1.5 8.5-9",
  wrench: "M14.5 5a4.5 4.5 0 0 0-4.2 6.1L4.5 17a1.8 1.8 0 0 0 2.5 2.5l5.9-5.8A4.5 4.5 0 0 0 19 9.5l-2.8 2.8-2.5-.5-.5-2.5L16 6.5A4.5 4.5 0 0 0 14.5 5z",
  stop: "M7.5 6h9A1.5 1.5 0 0 1 18 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 16.5v-9A1.5 1.5 0 0 1 7.5 6z",
  microphone: "M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3zM6 11.5a6 6 0 0 0 12 0M12 17.5V21",
} as const;

export type AstryxIconName = keyof typeof PATHS;

const glyph = (d: string): ReactNode => (
  <svg aria-hidden="true" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

export const basedIconRegistry = Object.fromEntries(Object.entries(PATHS).map(([name, d]) => [name, glyph(d)])) as Record<AstryxIconName, ReactNode>;
