// BSD-407 Teil 5: Kleine Marke im Inhalt (Kontext eines Meetings, Sprecher, Zeitmarke zum Abspielen). Astryx-Token:
// optional klickbar (unsichtbarer Knopf darin) und entfernbar (×-Knopf mit Namen). Aussehen aus dem Theme.
import { Token } from "@astryxdesign/core/Token";

export type BasedTokenColor = "default" | "red" | "orange" | "yellow" | "green" | "teal" | "cyan" | "blue" | "purple" | "pink" | "gray";

export interface BasedTokenProps {
  label: string;
  onClick?: () => void;
  /** Zeigt den ×-Knopf („Remove …“). */
  onRemove?: () => void;
  disabled?: boolean;
  color?: BasedTokenColor;
  size?: "sm" | "md";
  /** Zusatz für Screenreader (aria-description), z. B. „Play from here“. */
  description?: string;
  /** Zahlen und Zeiten: Mono mit Tabellenziffern. */
  mono?: boolean;
  testID?: string;
  /** Weitere data-Attribute (z. B. data-seconds). */
  data?: Record<`data-${string}`, string | undefined>;
}

/** Farben der Block-Palette (Swift/Notion-Namen) → Token-Farbe; unbekannt → default. */
export function tokenColor(color: string | undefined): BasedTokenColor {
  switch (color) {
    case "red": case "orange": case "yellow": case "green": case "blue": case "purple": case "pink": case "gray": return color;
    case "brown": return "orange";
    default: return "default";
  }
}

export function BasedToken({ label, onClick, onRemove, disabled = false, color = "default", size = "sm", description, mono = false, testID, data }: BasedTokenProps) {
  return (
    <Token label={label} size={size} color={color} isDisabled={disabled} className={mono ? "based-token-mono" : undefined}
      {...(onClick ? { onClick: () => onClick() } : {})} {...(onRemove ? { onRemove: () => onRemove() } : {})}
      {...(description ? { description } : {})} {...(testID ? { "data-testid": testID } : {})} {...(data ?? {})} />
  );
}
