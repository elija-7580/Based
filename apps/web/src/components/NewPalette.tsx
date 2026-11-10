// BSD-204: Befehlspalette „New…“ (⌘N), wie SearchOverlay.swift im Modus „New“: Seite, Datenbank, Chat, Import.
// Tippen filtert, Pfeiltasten wählen, Enter führt aus, Esc schließt. Aussehen wie Quick Find.
import { useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "../icons.js";

export interface PaletteCommand {
  id: string;
  title: string;
  hint?: string;
  icon: IconName;
  keywords?: string;
  run: () => void;
}

/** Befehle, deren Titel oder Stichworte alle Wörter der Eingabe enthalten (Reihenfolge bleibt). */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((c) => {
    const hay = (c.title + " " + (c.keywords ?? "")).toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function NewPalette({ commands, onClose }: { commands: readonly PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listID = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const items = filterCommands(commands, query);
  const run = (i: number) => {
    const c = items[i];
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="qf-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="New" className="qf" data-testid="new-palette">
        <div className="qf-field">
          <Icon name="plus" size={18} />
          <input ref={input} role="combobox" aria-expanded="true" aria-controls={listID}
            aria-activedescendant={items[selected] ? `${listID}-${selected}` : undefined}
            aria-label="New" placeholder="Create something new…" value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(items.length - 1, s + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(0, s - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); run(selected); }
              else if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }} />
        </div>
        <div className="qf-head t-meta">New</div>
        <ul id={listID} role="listbox" aria-label="Commands" className="qf-list">
          {items.map((c, i) => (
            <li key={c.id} id={`${listID}-${i}`} role="option" aria-selected={i === selected} className="qf-item"
              onMouseMove={() => setSelected(i)} onClick={() => run(i)}>
              <span className="tile"><Icon name={c.icon} size={18} /></span>
              <span className="grow"><strong>{c.title}</strong></span>
              {c.hint ? <span className="key t-data qf-key">{c.hint}</span> : null}
            </li>
          ))}
          {items.length === 0 ? <li className="qf-none t-desc">Nothing to create by that name</li> : null}
        </ul>
      </div>
    </div>
  );
}
