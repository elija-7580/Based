// Icons für Menüs im Editor: derselbe Satz wie in der Shell (24er-Raster, 2 px Strich, runde Enden), damit das
// Blockmenü aussieht wie das Seitenmenü. Der Editor ist ein eigenes Paket und kann die Icons der Shell nicht einbinden.
const P = {
  turn: "M4 8h13M13.5 4.5 17 8l-3.5 3.5M20 16H7M10.5 12.5 7 16l3.5 3.5",
  color: "M5 4.5h11A1.5 1.5 0 0 1 17.5 6v2A1.5 1.5 0 0 1 16 9.5H5A1.5 1.5 0 0 1 3.5 8V6A1.5 1.5 0 0 1 5 4.5zM17.5 7H19a1.5 1.5 0 0 1 1.5 1.5V11a1.5 1.5 0 0 1-1.5 1.5h-7V15M12 15v5",
  link: "M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1",
  duplicate: "M9.5 8h9A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 8 18.5v-9A1.5 1.5 0 0 1 9.5 8zM16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8",
  move: "M4 12h13M12 6l6 6-6 6M20.5 5v14",
  trash: "M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 12.5a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-12.5M10 10.5v6M14 10.5v6",
  markdown: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM7.5 15V9.5l2.5 3 2.5-3V15M16 9.5V15M14 13l2 2 2-2",
  sync: "M5 9a7.5 7.5 0 0 1 13-2.5M19 4v3.5h-3.5M19 15a7.5 7.5 0 0 1-13 2.5M5 20v-3.5h3.5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  wrap: "M4 6.5h16M4 12h13a3 3 0 0 1 0 6h-3.5M15.5 15.5 13 18l2.5 2.5M4 18h5",
  // BSD-407 Teil 6.3/6.4: Bildleiste und Datums-Erwähnungen im Block-Editor
  alignLeft: "M4 6h16M4 10h10M4 14h16M4 18h10",
  alignCenter: "M4 6h16M7 10h10M4 14h16M7 18h10",
  alignRight: "M4 6h16M10 10h10M4 14h16M10 18h10",
  caption: "M4.5 5.5h15A1.5 1.5 0 0 1 21 7v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17V7a1.5 1.5 0 0 1 1.5-1.5zM7 14.5h4M13 14.5h4",
  download: "M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14",
  expand: "M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6",
  calendar: "M5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5zM4 10h16M8 3v4M16 3v4",
  bell: "M18 15.5V11a6 6 0 0 0-12 0v4.5L4.5 18h15zM10 20.5a2 2 0 0 0 4 0",
  // Blocktypen („Turn into“)
  text: "M5.5 6.5V5h13v1.5M12 5v14M9.5 19h5",
  h1: "M4 6v12M11 6v12M4 12h7M16 13.5l2.5-1.5v6",
  h2: "M4 6v12M11 6v12M4 12h7M15.5 13.3a1.6 1.6 0 0 1 3.1.5c0 1.4-3.1 2.4-3.1 4.2H19",
  h3: "M4 6v12M11 6v12M4 12h7M15.5 12.2H19l-2 2.3a1.7 1.7 0 1 1-1.6 2.6",
  bullet: "M5 7h.01M5 12h.01M5 17h.01M9.5 7H20M9.5 12H20M9.5 17H20",
  numbered: "M4 5.5 5.5 5v4M4 14.6a1.2 1.2 0 0 1 2.3.4c0 1-2.3 1.6-2.3 3h2.5M10.5 7H20M10.5 16H20",
  todo: "M4 6.5l1.3 1.3L7.5 5.5M4.5 14.5h3v3h-3zM11 7h9M11 16h9",
  toggle: "M4.5 5l3 2-3 2zM4.5 14l3 2-3 2zM11 7h9M11 16h9",
  quote: "M4.5 12.5H8V8H4.5v4.5c0 2 .8 3.3 2.5 4M13 12.5h3.5V8H13v4.5c0 2 .8 3.3 2.5 4",
  code: "M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.5 5l-3 14",
  callout: "M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5zM8.5 9.5V8.5h7v1M12 8.5v7M10.5 15.5h3",
  equation: "M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5zM15 9.5V8.5H9l3 3.5-3 3.5h6v-1",
  page: "M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5zM14 3.5V8h4",
} as const;

export type MenuIconName = keyof typeof P;

export const menuIconPath = (name: MenuIconName): string => P[name];

export function MenuIcon({ name }: { name: MenuIconName }) {
  return (
    <svg className="bx-menu-icon" aria-hidden="true" viewBox="0 0 24 24">
      <path d={P[name]} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
