// BSD-210: Emoji-Picker mit Suche (wie Swift IconPicker, Reiter „Emoji“): Filterfeld, Raster, Random, Remove.
// Für Callout-Icons; exportiert, damit die Shell ihn für Seiten-Icons nutzen kann. Pfeiltasten wandern im Raster,
// Enter wählt, Esc schließt.
import { useReturnFocus } from "@based/ui/native";
import { randomIcon, searchEmoji } from "@based/core";
import { useEffect, useRef, useState } from "react";

export interface EmojiPickerProps {
  /** Aktuelles Icon (für „Remove“). */
  current?: string | undefined;
  onPick: (emoji: string | undefined) => void;
  onClose: () => void;
  className?: string;
}

const COLUMNS = 10;

export function EmojiPicker(props: EmojiPickerProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  useReturnFocus(); // BSD-304
  const list = searchEmoji(query, 600);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) props.onClose();
    };
    globalThis.document?.addEventListener("mousedown", away, true);
    return () => globalThis.document?.removeEventListener("mousedown", away, true);
  });
  return (
    <div ref={root} className={"bx-emoji " + (props.className ?? "")} role="dialog" aria-label="Choose an icon" contentEditable={false}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className="bx-emoji-bar">
        <input ref={input} className="bx-field" placeholder="Filter…" aria-label="Filter emoji" value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
            if (e.key === "Escape") props.onClose();
            else if (e.key in step) {
              e.preventDefault();
              setActive((a) => Math.min(Math.max(a + step[e.key]!, 0), Math.max(list.length - 1, 0)));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const hit = list[active];
              if (hit) props.onPick(hit[0]);
            }
          }} />
        <button type="button" className="bx-emoji-action" onClick={() => props.onPick(randomIcon())}>Random</button>
        {props.current ? <button type="button" className="bx-emoji-action" onClick={() => props.onPick(undefined)}>Remove</button> : null}
      </div>
      <div className="bx-emoji-grid" role="listbox" aria-label="Emoji">
        {list.map(([emoji, words], i) => (
          <button key={emoji} type="button" role="option" aria-selected={i === active} aria-label={words} title={words}
            className="bx-emoji-cell" data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => props.onPick(emoji)}>
            {emoji}
          </button>
        ))}
        {list.length === 0 ? <span className="bx-muted">No emoji found.</span> : null}
      </div>
    </div>
  );
}
