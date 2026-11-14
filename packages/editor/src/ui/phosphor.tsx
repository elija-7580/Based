// BSD-376 Teil 2: Phosphor-Icons (MIT, offline gebündelt) als Seiten- und Callout-Icon. Die Pfaddaten (~170 kB gzip)
// liegen in einem eigenen Chunk und werden erst geladen, wenn ein Phosphor-Icon zu sehen ist oder der Reiter „Icons“
// aufgeht. Bis dahin hält ein leerer Platz in Icon-Größe die Zeile ruhig (nichts springt).
import { isEmojiIcon } from "./env.js";
import { parsePhosphorIcon, type IconColor } from "@based/core";
import { useSyncExternalStore, type ReactNode } from "react";

export interface PhosphorEntry {
  name: string;
  words: string;
  svg: string;
}

let entries: PhosphorEntry[] | undefined;
let byName: Map<string, PhosphorEntry> | undefined;
let loading: Promise<PhosphorEntry[]> | undefined;
const listeners = new Set<() => void>();

export function loadPhosphor(): Promise<PhosphorEntry[]> {
  if (entries) return Promise.resolve(entries);
  loading ??= import("./phosphor-data.js").then((m) => {
    entries = m.PHOSPHOR_ICONS.map(([name, words, svg]) => ({ name, words, svg }));
    byName = new Map(entries.map((e) => [e.name, e]));
    for (const l of listeners) l();
    return entries;
  });
  return loading;
}

/** Alle Phosphor-Icons, sobald geladen (stößt das Laden an). */
export function usePhosphor(): PhosphorEntry[] | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      void loadPhosphor();
      return () => listeners.delete(cb);
    },
    () => entries,
    () => entries,
  );
}

/** Suche wie bei Emojis: erst Wortanfänge, dann enthaltene Treffer. */
export function searchPhosphor(all: readonly PhosphorEntry[], query: string): PhosphorEntry[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...all];
  const prefix = all.filter((e) => e.words.split(" ").some((w) => w.startsWith(q)));
  const seen = new Set(prefix);
  return [...prefix, ...all.filter((e) => !seen.has(e) && e.words.includes(q))];
}

export const iconColorVar = (color: IconColor) => (color === "gray" ? "var(--muted)" : `var(--block-${color}-text)`);

/** BSD-407 Teil 3: SVG-Markup eines Phosphor-Icons für DOM ohne React (Erwähnungen im Block-Editor); stößt das Laden an. */
export function phosphorMarkup(icon: string | undefined): string | undefined {
  const ref = parsePhosphorIcon(icon);
  if (!ref) return undefined;
  void loadPhosphor();
  const entry = byName?.get(ref.name);
  if (!entry) return undefined;
  return `<span class="bx-phosphor-wrap" style="color: ${iconColorVar(ref.color)}"><svg class="bx-phosphor" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" data-phosphor="${ref.name}">${entry.svg}</svg></span>`;
}

/** Laden der Phosphor-Daten abwarten (danach neu zeichnen). */
export function onPhosphorLoaded(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Rohes Phosphor-SVG (Pfaddaten aus dem gebündelten Satz). */
export function PhosphorSvg({ svg, name }: { svg: string | undefined; name: string }) {
  return <svg className="bx-phosphor" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" data-phosphor={name} {...(svg ? { dangerouslySetInnerHTML: { __html: svg } } : {})} />;
}

/** Ein Phosphor-Icon in Schriftgröße (1em), Farbe aus den Block-Text-Tokens. */
export function PhosphorGlyph({ name, color }: { name: string; color: IconColor }) {
  usePhosphor();
  const entry = byName?.get(name);
  return <span className="bx-phosphor-wrap" style={{ color: iconColorVar(color) }}><PhosphorSvg svg={entry?.svg} name={name} /></span>;
}

/** Seiten-/Callout-Icon zeichnen: Emoji als Text, Phosphor als SVG, sonst `fallback`. */
export function IconView({ icon, fallback }: { icon: string | undefined; fallback: ReactNode }) {
  const ref = parsePhosphorIcon(icon);
  if (ref) return <PhosphorGlyph name={ref.name} color={ref.color} />;
  return <>{isEmojiIcon(icon) ? icon : fallback}</>;
}

/** Hat die Seite ein eigenes, zeichenbares Icon (Emoji oder Phosphor)? */
export function isDrawableIcon(icon: string | undefined): icon is string {
  return isEmojiIcon(icon) || parsePhosphorIcon(icon) !== undefined;
}
