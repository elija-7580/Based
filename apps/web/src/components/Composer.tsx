// Composer (v8): graue Fassung, weißes Feld, Pillen Agent · Compute · Permission mit Popover-Menüs.
// BSD-159: mit `onSubmit` wird er zum echten Eingabefeld des Chats (mehrzeilig, Enter sendet, Shift+Enter bricht um,
// Stop-Knopf während einer Antwort); Optionen und Auswahl der Pillen können von außen kommen. Ohne `onSubmit`
// bleibt er die Vorschau auf Home wie bisher.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../icons.js";

export interface ComposerOption { name: string; desc: string; icon: IconName; meta?: string }
type Option = ComposerOption;
export type ComposerMenuKey = "agent" | "compute" | "permission";
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

export interface ComposerProps {
  showDetails: boolean;
  /** Senden (macht das Feld zum echten Chat-Eingabefeld). Gibt `false` zurück, wenn nicht gesendet wurde. */
  onSubmit?: (text: string) => boolean | void;
  /** Eine Antwort läuft: Stop-Knopf neben Senden (Senden reiht ein). */
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Eigene Optionen je Pille (z. B. die eingetragenen Modelle unter Compute). */
  options?: Partial<Record<ComposerMenuKey, ComposerOption[]>>;
  /** Fußzeile eines Menüs (z. B. Link zu den Einstellungen). */
  foot?: Partial<Record<ComposerMenuKey, ReactNode>>;
  picked?: Partial<Record<ComposerMenuKey, string>>;
  onPick?: (key: ComposerMenuKey, name: string) => void;
  /** Pillen, die nicht gezeigt werden. */
  hide?: ComposerMenuKey[];
  /** Text in der Details-Zeile (sonst die Vorschau). */
  details?: ReactNode;
  autoFocus?: boolean;
  /** ID des Eingabefelds (Label). */
  inputID?: string;
  /** Der Entwurf hat sich geändert (Agent Brain: Skill-Chips, sensible Stellen). */
  onDraftChange?: (text: string) => void;
  /** Unsichtbares Label des Felds (Standard „Ask Based“). */
  label?: string;
}

export function Composer({ showDetails, onSubmit, busy = false, onStop, disabled = false, placeholder, options, foot, picked: pickedProp, onPick, hide = [], details, autoFocus, inputID = "ask", onDraftChange, label = "Ask Based" }: ComposerProps) {
  const [open, setOpen] = useState<Menu["key"] | null>(null);
  const [pickedState, setPicked] = useState<Record<Menu["key"], string>>({ agent: "Main", compute: "Auto", permission: "Ask before edits" });
  const picked = { ...pickedState, ...pickedProp };
  const [text, setTextState] = useState("");
  const setText = (t: string) => {
    setTextState(t);
    onDraftChange?.(t);
  };
  const ref = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const live = onSubmit !== undefined;
  const menus = MENUS.filter((m) => !hide.includes(m.key)).map((m) => ({ ...m, options: options?.[m.key] ?? m.options, foot: foot?.[m.key] ?? m.foot }));

  const submit = () => {
    if (!onSubmit || disabled || !text.trim()) return;
    if (onSubmit(text) === false) return;
    setText("");
    field.current?.focus();
  };

  // Feld wächst mit dem Text (bis zu einer Höhe, dann scrollt es).
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

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

  const menu = menus.find((m) => m.key === open);
  return (
    <div className="composer" ref={ref}>
      <form className="composer-field" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label htmlFor={inputID} className="sr-only">{label}</label>
        {live ? (
          <textarea
            id={inputID}
            ref={field}
            rows={1}
            className="composer-input"
            placeholder={placeholder ?? "Ask your notes, or tell Based what to do"}
            value={text}
            disabled={disabled}
            autoFocus={autoFocus}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
        ) : (
          <input id={inputID} placeholder="Ask your notes, or tell Based what to do" />
        )}
        <div className="composer-bar">
          <button type="button" className="icon-btn" aria-label="Attach">
            <Icon name="plus" size={18} />
          </button>
          {menus.map((m) => (
            <button key={m.key} type="button" className="pill" aria-haspopup="listbox" aria-expanded={open === m.key} onClick={() => setOpen(open === m.key ? null : m.key)}>
              <span className="pill-icon"><Icon name={m.icon} size={15} /></span>
              <span className="sr-only">{m.title}: </span>
              {picked[m.key]}
              <Icon name="chevron" size={14} />
            </button>
          ))}
          {showDetails ? <span className="details">{details ?? "model auto · ask before edits"}</span> : null}
          {busy && onStop ? (
            <button type="button" className={"icon-btn stop" + (showDetails ? "" : " push")} aria-label="Stop" title="Stop the answer" onClick={onStop}>
              <Icon name="stop" size={16} />
            </button>
          ) : null}
          <button type="submit" className="icon-btn primary send" aria-label={busy ? "Queue message" : "Send"} disabled={live && (disabled || !text.trim())}>
            <Icon name="send" size={18} />
          </button>
        </div>
      </form>
      {menu ? (
        <div className="popover" role="listbox" aria-label={menu.title} style={{ left: `calc(var(--space-8) * ${menus.indexOf(menu) * 2 + 1})` }}>
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
                setPicked({ ...pickedState, [menu.key]: o.name });
                onPick?.(menu.key, o.name);
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
