// Eigene Icons für die Editor-Menüs (Slash, @, Blockmenü, Turn into) – Based-Stil wie apps/web/src/icons.tsx:
// 24-px-Raster, 2 px Strich, runde Enden, kein Emoji. Größe 1em, Farbe currentColor (die Kachel setzt beides).
// Reine Daten + ein Renderer, damit Tests prüfen können, dass jeder Slash-Eintrag ein Icon hat.

const RECT = "M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5z";
const H = "M4 6v12M11 6v12M4 12h7";
const H_SMALL = "M7.5 7v10M13 7v10M7.5 12H13";
const TRI = "M3 9.5 5.8 12 3 14.5";

export const BLOCK_ICON_PATHS = {
  text: "M5.5 7V5.5h13V7M12 5.5v13M9.5 18.5h5",
  heading1: H + "M15.5 9 18.5 6.5V18",
  heading2: H + "M14.5 8.8a2.6 2.6 0 0 1 5.2.2c0 2.2-1.9 3.4-5.2 9h5.6",
  heading3: H + "M14.8 6.5h4.9l-2.9 4a3.1 3.1 0 1 1-2.4 5.4",
  bulletedList: "M5 6a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM5 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM5 16a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM10 7h10M10 12h10M10 17h10",
  numberedList: "M4 6.2 5.5 5V10M3.8 14.6a1.3 1.3 0 0 1 2.6.1c0 1-2.6 2.4-2.6 3.8h2.8M10.5 7.5H20M10.5 16.5H20",
  todo: RECT + "M8.5 12.2l2.5 2.5 4.5-5",
  toggle: "M5 6.5 9.5 10 5 13.5zM13 10h7M9 17h11",
  quote: "M5 5v14M10 8h9.5M10 12h9.5M10 16h6",
  toggleHeading1: TRI + H_SMALL + "M16.5 9.2 19 7v10",
  toggleHeading2: TRI + H_SMALL + "M16 9a2.2 2.2 0 0 1 4.4.2c0 1.8-1.6 2.9-4.4 7.8h4.7",
  toggleHeading3: TRI + H_SMALL + "M16.2 7h4.2l-2.5 3.4a2.7 2.7 0 1 1-2.1 4.7",
  section: RECT + "M4 9.5h16M8 13.5h8M8 16.5h5",
  callout: RECT + "M8 9h2.5v2.5H8zM13.5 10.2H16M8 15h8",
  code: "M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5M13.5 5.5l-3 13",
  divider: "M3.5 12h17M8 7h8M8 17h8",
  table: RECT + "M4 10h16M4 15h16M10 4.5v15",
  columns: RECT + "M12 4.5v15",
  page: "M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5zM14 3.5V8h4M9 13h6M9 16.5h4",
  database: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM4 10h16M10 10v9",
  linkedDatabase: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5V11M4 10h16M4 10v7.5A1.5 1.5 0 0 0 5.5 19H11M10 10v4M15 14h5v5M20 14l-6 6",
  image: RECT + "M9 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4 16.5l4.5-4.5 3.5 3.5 2.5-2.5 5.5 5.5",
  video: RECT + "M10 9v6l5-3z",
  audio: "M4 10v4M8 7v10M12 4.5v15M16 7v10M20 10v4",
  file: "M18.5 11.5l-6.4 6.4a4 4 0 0 1-5.7-5.7l7-7a2.7 2.7 0 0 1 3.8 3.8l-6.9 6.9a1.3 1.3 0 0 1-1.9-1.9l6.2-6.2",
  bookmark: "M7.5 4h9A1.5 1.5 0 0 1 18 5.5V20l-6-4-6 4V5.5A1.5 1.5 0 0 1 7.5 4z",
  embed: RECT + "M10 9.5 7.5 12l2.5 2.5M14 9.5l2.5 2.5-2.5 2.5",
  equation: "M17.5 5.5h-11l6 6.5-6 6.5h11",
  inlineEquation: "M3.5 13H6l3 6 4.5-14h7",
  mermaid: "M4 4.5h6v5H4zM14 14.5h6v5h-6zM7 9.5V17h7M17 9.5V14M14 7h3v2.5",
  html: "M7.5 7.5 3.5 12l4 4.5M16.5 7.5l4 4.5-4 4.5M9.5 9.5h5M9.5 14.5h5",
  meeting: "M12 3.5a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0v-5a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v3.5M9 20.5h6",
  button: "M6.5 7h11A3.5 3.5 0 0 1 21 10.5v0A3.5 3.5 0 0 1 17.5 14H14M9 14H6.5A3.5 3.5 0 0 1 3 10.5v0A3.5 3.5 0 0 1 6.5 7M10 10.5l1.5 10 2.5-3.5 4 .5z",
  // KI ohne Sparkle: Sprechblase mit Cursor-Strich
  askAI: "M5 5.5h14A1.5 1.5 0 0 1 20.5 7v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5zM8 11.5h5M15.5 9v5",
  tableOfContents: "M4.5 6.5h15M8.5 12h11M8.5 17.5h11M4.5 12h.01M4.5 17.5h.01",
  date: "M5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5zM4 10h16M8 3v4M16 3v4",
  // Blockmenü-Aktionen
  open: "M13 5h6v6M19 5l-8 8M10 6H6.5A1.5 1.5 0 0 0 5 7.5v10A1.5 1.5 0 0 0 6.5 19h10a1.5 1.5 0 0 0 1.5-1.5V14",
  link: "M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1",
  markdown: RECT + "M7 15V9l2.5 3L12 9v6M15.5 9v6M13.5 13l2 2 2-2",
  sync: "M19.5 9A8 8 0 0 0 5 7.5M4.5 4v3.5H8M4.5 15A8 8 0 0 0 19 16.5M19.5 20v-3.5H16",
  trash: "M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 12.5a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-12.5M10 10.5v6M14 10.5v6",
  duplicate: "M9.5 8h9A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 8 18.5v-9A1.5 1.5 0 0 1 9.5 8zM16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8",
  move: "M4 12h13M12 6l6 6-6 6M20.5 5v14",
  moveUp: "M12 19V5M6 11l6-6 6 6",
  moveDown: "M12 5v14M6 13l6 6 6-6",
  palette: "M12 3.5c3 3.6 6 7 6 10.2a6 6 0 0 1-12 0C6 10.5 9 7.1 12 3.5z",
  chevronRight: "M10 7l5 5-5 5",
} as const;

export type BlockIconName = keyof typeof BLOCK_ICON_PATHS;

export const isBlockIcon = (name: string): name is BlockIconName => Object.hasOwn(BLOCK_ICON_PATHS, name);

/** Ein Editor-Icon in Schriftgröße (1em), Strichfarbe = Textfarbe. */
export function BlockIcon({ name }: { name: BlockIconName }) {
  return (
    <svg className="bx-menu-icon bx2-glyph" aria-hidden="true" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" data-icon={name}>
      <path d={BLOCK_ICON_PATHS[name]} />
    </svg>
  );
}
