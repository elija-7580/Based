// Umschalter (docs/design/elements.md, Abschnitt 4): wechselt zwischen 2–5 Ansichten desselben Inhalts
// (Pages · Graph · Meetings; Summary · Notes · Transcript; Ansichten einer Datenbank). Schiene `surface-raised`,
// Pille, Höhe `md`, aktives Segment `bg` + `shadow-control` – Aussehen aus dem Theme. Mehr als fünf Einträge: Menü.
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";

export interface BasedSwitcherItem {
  id: string;
  label: string;
}

export interface BasedSwitcherProps {
  /** Name der Gruppe für Screenreader (wird nicht angezeigt). */
  label: string;
  items: readonly BasedSwitcherItem[];
  value: string;
  onChange: (id: string) => void;
  /** Segmente gleich breit über die ganze Breite (z. B. in einem Seitenblatt). */
  fill?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function BasedSwitcher({ label, items, value, onChange, fill = false, disabled = false, testID }: BasedSwitcherProps) {
  return (
    <span className="based-switcher" data-fill={fill ? "" : undefined} data-testid={testID}>
      <SegmentedControl label={label} value={value} onChange={onChange} layout={fill ? "fill" : "hug"} isDisabled={disabled}>
        {items.map((it) => <SegmentedControlItem key={it.id} value={it.id} label={it.label} />)}
      </SegmentedControl>
    </span>
  );
}
