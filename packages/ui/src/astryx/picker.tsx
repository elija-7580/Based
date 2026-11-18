// Filter, Auswahl (docs/design/elements.md, Abschnitt 4): Pille `surface-raised`, Höhe `md`, Text „Type: All types“
// und Pfeil. Öffnet das eine Menü; der gewählte Eintrag trägt ein Häkchen. Ist ein Filter gesetzt (nicht der
// Standardwert), steht die Pille auf `selected`.
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { CHECK, Glyph } from "./mediaIcons.js";
import { pickerText, type BasedPickerOption } from "./variants.js";

export type { BasedPickerOption };

export interface BasedPickerProps {
  /** Was gewählt wird („Type“); steht vor dem Wert in der Pille. */
  label: string;
  options: readonly BasedPickerOption[];
  value: string;
  onChange: (id: string) => void;
  /** Wert, der „kein Filter“ bedeutet; weicht `value` davon ab, ist die Pille aktiv. */
  defaultValue?: string;
  testID?: string;
}

export function BasedPicker({ label, options, value, onChange, defaultValue, testID }: BasedPickerProps) {
  const active = defaultValue !== undefined && value !== defaultValue;
  return (
    <span className="based-picker" data-active={active ? "" : undefined} data-testid={testID}>
      <DropdownMenu
        button={{ label: pickerText(label, options, value), variant: "secondary" }}
        items={options.map((o) => ({
          label: o.label,
          ...(o.description ? { description: o.description } : {}),
          onClick: () => onChange(o.id),
          ...(o.id === value ? { endContent: <Glyph d={CHECK} size={16} /> } : {}),
        }))}
      />
    </span>
  );
}
