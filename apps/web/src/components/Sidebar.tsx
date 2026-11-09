// Seitenleiste (v8): auf canvas, aktiver Eintrag als weiße Pille mit gefülltem Icon, Zähler als Badge.
import markLight from "../../../../docs/design/logo/based-mark-small.svg?url";
import markDark from "../../../../docs/design/logo/based-mark-small-on-dark.svg?url";
import type { Screen } from "../data.js";
import { Icon, type IconName } from "../icons.js";

interface NavEntry { name: string; icon: IconName; cut?: IconName; go: Screen; key?: string; badge?: string }

/** Nur geschlossene Formen werden im aktiven Zustand gefüllt (Lupe und Zahnrad nicht). */
const FILLABLE = new Set<IconName>(["home", "inbox", "agent", "graph"]);

const NAV: NavEntry[] = [
  { name: "Home", icon: "home", cut: "homeDoor", go: "home", key: "⌘1" },
  { name: "Search", icon: "search", go: "home", key: "⌘K" },
  { name: "Inbox", icon: "inbox", go: "home", badge: "3" },
  { name: "Agents", icon: "agent", go: "home", badge: "2" },
  { name: "Graph", icon: "graph", go: "graph", key: "⌘G" },
  { name: "Settings", icon: "settings", go: "settings", key: "⌘," },
];

const SPACES: { letter: string; name: string; go: Screen }[] = [
  { letter: "U", name: "University", go: "page" },
  { letter: "B", name: "Based", go: "db" },
  { letter: "W", name: "Work", go: "home" },
  { letter: "P", name: "Personal", go: "home" },
];

export function Sidebar({ screen, onNavigate }: { screen: Screen; onNavigate: (s: Screen) => void }) {
  return (
    <nav className="sidebar" aria-label="Workspace">
      <div className="brand">
        <img className="on-light" src={markLight} alt="" />
        <img className="on-dark" src={markDark} alt="" />
        <span className="wordmark">based</span>
      </div>
      {NAV.map((n) => {
        const active = n.go === screen && (n.name !== "Search" && n.name !== "Inbox" && n.name !== "Agents");
        return (
          <button key={n.name} type="button" className="nav-item" aria-current={active ? "page" : undefined} onClick={() => onNavigate(n.go)}>
            <Icon name={n.icon} filled={active && FILLABLE.has(n.icon)} {...(n.cut ? { cut: n.cut } : {})} />
            {n.name}
            {n.badge ? <span className="badge" aria-label={`${n.badge} new`}>{n.badge}</span> : n.key ? <span className="key t-data">{n.key}</span> : null}
          </button>
        );
      })}
      <div className="nav-group t-meta">Spaces</div>
      {SPACES.map((s) => (
        <button key={s.name} type="button" className="nav-item" aria-current={s.go === screen && s.go !== "home" ? "page" : undefined} onClick={() => onNavigate(s.go)}>
          <span className="space-tile" aria-hidden="true">{s.letter}</span>
          {s.name}
        </button>
      ))}
      <div className="synced t-meta">
        <span className="dot synced-dot" aria-hidden="true" />
        Synced
      </div>
    </nav>
  );
}
