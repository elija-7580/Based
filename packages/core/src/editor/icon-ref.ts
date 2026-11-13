// BSD-376 Teil 2: Icon-Referenz für Phosphor-Icons (MIT, offline gebündelt) als Seiten- und Callout-Icon.
// Gespeichert als reiner String `phosphor:<name>:<farbe>`, damit `props.icon` ein String bleibt wie bei Emojis.
// Alte Clients sehen reines ASCII und zeigen ihr Standard-Icon (`isEmojiIcon` ist für ASCII falsch).

/** Farben wie Notions Icon-Farben; gezeichnet mit den Block-Text-Tokens (`--block-<farbe>-text`), Grau = `--muted`. */
export const ICON_COLORS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type IconColor = (typeof ICON_COLORS)[number];

export interface PhosphorIconRef {
  name: string;
  color: IconColor;
}

const PREFIX = "phosphor:";
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `phosphor:<name>:<farbe>` → Referenz; alles andere (Emoji, Swift-Symbolnamen, Objekte) → `undefined`. */
export function parsePhosphorIcon(icon: unknown): PhosphorIconRef | undefined {
  if (typeof icon !== "string" || !icon.startsWith(PREFIX)) return undefined;
  const [name = "", color = "gray"] = icon.slice(PREFIX.length).split(":");
  if (!NAME.test(name)) return undefined;
  return { name, color: (ICON_COLORS as readonly string[]).includes(color) ? (color as IconColor) : "gray" };
}

export function phosphorIcon(name: string, color: IconColor = "gray"): string {
  return `${PREFIX}${name}:${color}`;
}

/** Text-Ersatz für Exporte (Markdown, HTML-Titel): Phosphor lässt sich nicht als Text schreiben. */
export function iconAsText(icon: string | undefined): string | undefined {
  return icon === undefined || parsePhosphorIcon(icon) ? undefined : icon;
}
