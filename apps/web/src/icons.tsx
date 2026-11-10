// Icons nach v8: Linien auf 24-px-Raster, 2 px, runde Enden; aktive Navigation gefüllt. Kein Sparkle für KI.

const P = {
  home: "M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H5.5A1.5 1.5 0 0 1 4 19z",
  homeDoor: "M10 20.5v-5h4v5",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.6-4.6",
  inbox: "M4 13 6.6 6.2A1.5 1.5 0 0 1 8 5.2h8a1.5 1.5 0 0 1 1.4 1L20 13v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18zM4 13h4.5l1.5 2.5h4l1.5-2.5H20",
  agent: "M12 3.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.5 20.5a7.5 7.5 0 0 1 15 0z",
  graph: "M6.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17.5 6a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM10.5 15a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8.8 7.2l6.4.8M7.5 8.8l2.2 6.4M16 10.6l-4 5",
  settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8",
  model: "M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1zM10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5",
  perm: "M12 3.5 19 6.5v5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9v-5zM9 12l2 2 4-4",
  auto: "M5 12h4l2-6 2 12 2-6h4",
  fast: "M13 3 5 14h6l-1 7 8-11h-6z",
  deep: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z",
  pick: "M4 7h16M4 12h16M4 17h10",
  ask: "M12 3.5 19 6.5v5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9v-5zM12 9v4M12 16h.01",
  free: "M7 11V8a5 5 0 0 1 9.6-2M5.5 11h13a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-6A1.5 1.5 0 0 1 5.5 11z",
  research: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.6-4.6",
  night: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  tutor: "M3 9l9-5 9 5-9 5zM7 11.5V16c0 1.5 2.2 3 5 3s5-1.5 5-3v-4.5",
  plus: "M12 5v14M5 12h14",
  send: "M12 19V5M6 11l6-6 6 6",
  chevron: "M7 10l5 5 5-5",
  check: "M5 12.5l4.5 4.5L19 7.5",
  page: "M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9.5A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5zM14 3.5V8h4",
  calendar: "M5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5zM4 10h16M8 3v4M16 3v4",
  trash: "M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 12.5a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-12.5M10 10.5v6M14 10.5v6",
  star: "M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4.1-4 5.7-.8z",
  back: "M15 5l-7 7 7 7",
  forward: "M9 5l7 7-7 7",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  close: "M6 6l12 12M18 6 6 18",
  restore: "M4 12a8 8 0 1 0 2.3-5.6M4 4.5v4h4",
  right: "M10 7l5 5-5 5",
  stop: "M7 7h10v10H7z",
  history: "M4 12a8 8 0 1 0 2.3-5.6M4 4.5v4h4M12 8v4.5l3 2",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
  collapse: "M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7",
  chat: "M5 5.5h14A1.5 1.5 0 0 1 20.5 7v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z",
  database: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM4 10h16M10 10v9",
  library: "M4.5 4.5h3.5v15H4.5zM10 4.5h3.5v15H10zM15.3 5.4l2.9-.8 3.6 14-2.9.8z",
  teamspace: "M9 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM3.5 19.5a5.5 5.5 0 0 1 11 0M16 5.5a2.5 2.5 0 0 1 0 5M17.5 14.5a4.5 4.5 0 0 1 3 5",
  duplicate: "M9.5 8h9A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 8 18.5v-9A1.5 1.5 0 0 1 9.5 8zM16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8",
  move: "M4 12h13M12 6l6 6-6 6M20.5 5v14",
  edit: "M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17zM13.5 8.5l3 3",
  sidebar: "M5.5 4.5h13A1.5 1.5 0 0 1 20 6v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18V6a1.5 1.5 0 0 1 1.5-1.5zM9.5 4.5v15",
  terminal: "M4.5 4.5h15a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V6a1.5 1.5 0 0 1 1.5-1.5zM7 9.5l3 2.5-3 2.5M12.5 15H17",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-6A1.5 1.5 0 0 1 5.5 11z",
} as const;

export type IconName = keyof typeof P;

export function Icon({ name, size = 20, filled = false, cut }: { name: IconName; size?: number; filled?: boolean; cut?: IconName }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" style={{ flex: "none" }}>
      <path d={P[name]} fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {cut && filled ? <path d={P[cut]} fill="none" stroke="var(--bg)" strokeWidth={2} strokeLinecap="round" /> : null}
    </svg>
  );
}
