// Datums- und Uhrzeitfeld ohne Systemauswahl: Textfeld (ISO-Tag bzw. HH:MM, direkt tippbar) plus Based-Kalender
// bzw. Zeitliste. Gemeldet wird wie bei <input type="date|time">: nur gültige Werte oder "" (geleert).
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { openCalendar, openTimeList } from "./calendar.js";
import type { Layer } from "./layer.js";
import { parseDay, parseTime } from "./logic.js";

interface FieldProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
  "aria-label"?: string;
  disabled?: boolean;
  /** Leeren erlaubt (meldet ""); sonst springt ein geleertes Feld beim Verlassen auf den alten Wert zurück. */
  clearable?: boolean;
}

function useField(p: FieldProps, parse: (t: string) => string | undefined, open: (el: HTMLInputElement, value: string, pick: (v: string) => void, closed: () => void) => Layer) {
  const [draft, setDraft] = useState(p.value);
  const ref = useRef<HTMLInputElement>(null);
  const layer = useRef<Layer | undefined>(undefined);
  const latest = useRef(p);
  latest.current = p;
  useEffect(() => { setDraft(p.value); }, [p.value]);
  useEffect(() => () => layer.current?.close(), []);
  const show = () => {
    const el = ref.current;
    if (!el || p.disabled || layer.current?.open) return;
    layer.current = open(el, parse(el.value) ?? latest.current.value, (v) => { setDraft(v); latest.current.onChange(v); }, () => { layer.current = undefined; });
  };
  return {
    ref, value: draft, type: "text" as const, autoComplete: "off", spellCheck: false, disabled: p.disabled,
    className: "nf-field" + (p.className ? " " + p.className : ""), "aria-label": p["aria-label"], "aria-haspopup": "dialog" as const,
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const text = e.target.value;
      setDraft(text);
      const parsed = parse(text);
      if (parsed !== undefined) { if (parsed !== p.value) p.onChange(parsed); } else if (text.trim() === "" && p.clearable && p.value !== "") p.onChange("");
    },
    // Nicht schon beim Fokus: wer per Tab kommt oder tippt, soll die Felder darunter weiter sehen. Klick oder ↓ öffnet.
    onClick: show,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === "ArrowDown" && !layer.current?.open) { e.preventDefault(); show(); } },
    onBlur: () => { layer.current?.close(); setDraft(latest.current.value); },
  };
}

export function DateField(p: FieldProps) {
  const field = useField(p, parseDay, (el, value, onPick, onClose) => openCalendar(el, { value, onPick, onClose }));
  return <input {...field} inputMode="numeric" placeholder="YYYY-MM-DD" data-field="date" />;
}

export function TimeField(p: FieldProps) {
  const field = useField(p, parseTime, (el, value, onPick, onClose) => openTimeList(el, { value, onPick, onClose }));
  return <input {...field} inputMode="numeric" placeholder="HH:MM" data-field="time" />;
}
