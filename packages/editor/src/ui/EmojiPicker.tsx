// BSD-210: Emoji-Picker mit Suche (wie Swift IconPicker, Reiter „Emoji“): Filterfeld, Raster, Random, Remove.
// BSD-376 Teil 2: zweiter Reiter „Icons“ mit Phosphor (offline gebündelt) und Farbwahl wie Notion; gespeichert als
// `phosphor:<name>:<farbe>`. Für Seiten- und Callout-Icons. Pfeiltasten wandern im Raster, Enter wählt, Esc schließt.
import { useReturnFocus } from "@based/ui/native";
import { ICON_COLORS, parsePhosphorIcon, phosphorIcon, randomIcon, searchEmoji, type IconColor } from "@based/core";
import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import { iconColorVar, PhosphorSvg, searchPhosphor, usePhosphor } from "./phosphor.js";

export interface EmojiPickerProps {
  /** Aktuelles Icon (für „Remove“ und den Start-Reiter). */
  current?: string | undefined;
  onPick: (emoji: string | undefined) => void;
  onClose: () => void;
  className?: string;
}

const COLUMNS = 10;

/** Ein Knopf der Auswahl (Reiter, Farbpunkt, Rasterzelle, Random/Remove) – gleiche Grundform, Aussehen per Klasse. */
function Pick(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...props} />;
}
type Tab = "emoji" | "icons";

export function EmojiPicker(props: EmojiPickerProps) {
  const currentRef = parsePhosphorIcon(props.current);
  const [tab, setTab] = useState<Tab>(currentRef ? "icons" : "emoji");
  const [color, setColor] = useState<IconColor>(currentRef?.color ?? "gray");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  useReturnFocus(); // BSD-304
  const phosphor = usePhosphor();
  const emojis = tab === "emoji" ? searchEmoji(query, 600) : [];
  const icons = tab === "icons" && phosphor ? searchPhosphor(phosphor, query) : [];
  const count = tab === "emoji" ? emojis.length : icons.length;
  const pickAt = (i: number) => {
    if (tab === "emoji") {
      const hit = emojis[i];
      if (hit) props.onPick(hit[0]);
    } else {
      const hit = icons[i];
      if (hit) props.onPick(phosphorIcon(hit.name, color));
    }
  };
  useEffect(() => input.current?.focus(), [tab]);
  useEffect(() => setActive(0), [query, tab]);
  useEffect(() => {
    grid.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) props.onClose();
    };
    globalThis.document?.addEventListener("mousedown", away, true);
    return () => globalThis.document?.removeEventListener("mousedown", away, true);
  });
  const random = () => {
    if (tab === "emoji" || !phosphor || phosphor.length === 0) props.onPick(randomIcon());
    else props.onPick(phosphorIcon(phosphor[Math.floor(Math.random() * phosphor.length)]!.name, color));
  };
  return (
    <div ref={root} className={"bx-emoji " + (props.className ?? "")} role="dialog" aria-label="Choose an icon" contentEditable={false}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className="bx-emoji-tabs" role="tablist" aria-label="Icon type">
        {(["emoji", "icons"] as const).map((t) => (
          <Pick key={t} role="tab" className="bx-emoji-tab" aria-selected={tab === t} data-tab={t}
            onClick={() => { setTab(t); setQuery(""); }}>
            {t === "emoji" ? "Emoji" : "Icons"}
          </Pick>
        ))}
        <span className="bx-emoji-tabs-end">
          <Pick className="bx-emoji-action" onClick={random}>Random</Pick>
          {props.current ? <Pick className="bx-emoji-action" onClick={() => props.onPick(undefined)}>Remove</Pick> : null}
        </span>
      </div>
      <div className="bx-emoji-bar">
        <input ref={input} className="bx-field" placeholder="Filter…" aria-label={tab === "emoji" ? "Filter emoji" : "Filter icons"} value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            const step: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS };
            if (e.key === "Escape") props.onClose();
            else if (e.key in step) {
              e.preventDefault();
              setActive((a) => Math.min(Math.max(a + step[e.key]!, 0), Math.max(count - 1, 0)));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pickAt(active);
            }
          }} />
        {tab === "icons" ? (
          <span className="bx-emoji-colors" role="radiogroup" aria-label="Icon colour">
            {ICON_COLORS.map((c) => (
              <Pick key={c} role="radio" aria-checked={color === c} aria-label={c} title={c[0]!.toUpperCase() + c.slice(1)}
                className="bx-emoji-color" data-color={c} style={{ color: iconColorVar(c) }} onClick={() => { setColor(c); input.current?.focus(); }} />
            ))}
          </span>
        ) : null}
      </div>
      <div ref={grid} className="bx-emoji-grid" role="listbox" aria-label={tab === "emoji" ? "Emoji" : "Icons"} data-tab={tab}>
        {tab === "emoji"
          ? emojis.map(([emoji, words], i) => (
              <Pick key={emoji} role="option" aria-selected={i === active} aria-label={words} title={words}
                className="bx-emoji-cell" data-active={i === active} onMouseEnter={() => setActive(i)} onClick={() => props.onPick(emoji)}>
                {emoji}
              </Pick>
            ))
          : icons.map((icon, i) => (
              <Pick key={icon.name} role="option" aria-selected={i === active} aria-label={icon.name.replace(/-/g, " ")}
                title={icon.name.replace(/-/g, " ")} className="bx-emoji-cell" data-active={i === active} data-icon={icon.name}
                style={{ color: iconColorVar(color) }} onMouseEnter={() => setActive(i)} onClick={() => props.onPick(phosphorIcon(icon.name, color))}>
                <PhosphorSvg svg={icon.svg} name={icon.name} />
              </Pick>
            ))}
        {tab === "icons" && !phosphor ? <span className="bx-muted bx-emoji-empty">Loading icons…</span> : null}
        {count === 0 && (tab === "emoji" || phosphor) ? <span className="bx-muted bx-emoji-empty">{tab === "emoji" ? "No emoji found." : "No icons found."}</span> : null}
      </div>
    </div>
  );
}
