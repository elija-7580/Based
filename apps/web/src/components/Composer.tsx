// Composer (v8): graue Fassung, weißes Feld, Pillen Agent · Compute · Permission mit Popover-Menüs.
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "../icons.js";

interface Option { name: string; desc: string; icon: IconName; meta?: string }
interface Menu { key: "agent" | "compute" | "permission"; title: string; hint: string; foot: string; icon: IconName; options: Option[] }

const MENUS: Menu[] = [
  {
    key: "agent", title: "Agent", hint: "who takes this", icon: "agent", foot: "The main agent can hand work to the others.",
    options: [
      { name: "Main", desc: "Plans, delegates, writes updates", icon: "agent", meta: "always on" },
      { name: "Tutor", desc: "Explains and quizzes you", icon: "tutor" },
      { name: "Researcher", desc: "Reads sources, cites them", icon: "research" },
      { name: "Nachtschicht", desc: "Works through the backlog at night", icon: "night", meta: "02:00" },
    ],
  },
  {
    key: "compute", title: "Compute", hint: "how hard Based thinks", icon: "model", foot: "Advanced: choose a specific model or your own API key.",
    options: [
      { name: "Auto", desc: "Picks per task — recommended", icon: "auto" },
      { name: "Fast", desc: "Quick answers, light tasks", icon: "fast" },
      { name: "Deep", desc: "Long reasoning, big documents", icon: "deep" },
      { name: "Specific model…", desc: "Claude, GPT, Gemini, local", icon: "pick" },
    ],
  },
  {
    key: "permission", title: "Permission", hint: "what Based may do alone", icon: "perm", foot: "Agents never delete pages or share anything without asking.",
    options: [
      { name: "Ask every time", desc: "Confirm each change", icon: "ask" },
      { name: "Ask before edits", desc: "Reads freely, asks before writing", icon: "perm", meta: "default" },
      { name: "Work freely", desc: "Edits and runs in the sandbox", icon: "free" },
    ],
  },
];

export function Composer({ showDetails }: { showDetails: boolean }) {
  const [open, setOpen] = useState<Menu["key"] | null>(null);
  const [picked, setPicked] = useState<Record<Menu["key"], string>>({ agent: "Main", compute: "Auto", permission: "Ask before edits" });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const menu = MENUS.find((m) => m.key === open);
  return (
    <div className="composer" ref={ref}>
      <form className="composer-field" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="ask" className="sr-only">Ask Based</label>
        <input id="ask" placeholder="Ask your notes, or tell Based what to do" />
        <div className="composer-bar">
          <button type="button" className="icon-btn" aria-label="Attach">
            <Icon name="plus" size={18} />
          </button>
          {MENUS.map((m) => (
            <button key={m.key} type="button" className="pill" aria-haspopup="listbox" aria-expanded={open === m.key} onClick={() => setOpen(open === m.key ? null : m.key)}>
              <span className="pill-icon"><Icon name={m.icon} size={15} /></span>
              <span className="sr-only">{m.title}: </span>
              {picked[m.key]}
              <Icon name="chevron" size={14} />
            </button>
          ))}
          {showDetails ? <span className="details">model auto · ask before edits</span> : null}
          <button type="submit" className="icon-btn primary send" aria-label="Send">
            <Icon name="send" size={18} />
          </button>
        </div>
      </form>
      {menu ? (
        <div className="popover" role="listbox" aria-label={menu.title} style={{ left: `calc(var(--space-8) * ${MENUS.indexOf(menu) * 2 + 1})` }}>
          <div className="popover-head">
            <strong>{menu.title}</strong>
            <span className="t-desc">{menu.hint}</span>
          </div>
          {menu.options.map((o) => (
            <button
              key={o.name}
              type="button"
              role="option"
              className="option"
              aria-selected={picked[menu.key] === o.name}
              onClick={() => {
                setPicked({ ...picked, [menu.key]: o.name });
                setOpen(null);
              }}
            >
              <span className="tile"><Icon name={o.icon} /></span>
              <span className="grow" style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: "block" }}>{o.name}</strong>
                <span className="t-desc" style={{ display: "block" }}>{o.desc}</span>
              </span>
              {o.meta ? <span className="t-meta">{o.meta}</span> : null}
              <span className="check"><Icon name="check" size={18} /></span>
            </button>
          ))}
          <div className="popover-foot t-desc">{menu.foot}</div>
        </div>
      ) : null}
    </div>
  );
}
