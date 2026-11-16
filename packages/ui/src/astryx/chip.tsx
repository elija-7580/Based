// BSD-350: Filter-Chip (Umschalter in einer Leiste, z. B. Quick Find „Title only“, „In this page“) – Astryx
// ToggleButton im Theme „Based Default“: Pille, gedrückt = aria-pressed. Keine Farben hier.
import { ToggleButton } from "@astryxdesign/core/ToggleButton";

export interface BasedChipProps {
  label: string;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
  /** Erklärung beim Überfahren (z. B. „Only “Notes” and its sub-pages“). */
  tooltip?: string;
  disabled?: boolean;
  testID?: string;
}

export function BasedChip({ label, pressed, onChange, tooltip, disabled = false, testID }: BasedChipProps) {
  return (
    <ToggleButton label={label} size="sm" isPressed={pressed} isDisabled={disabled} onPressedChange={(p) => onChange(p)}
      {...(tooltip ? { tooltip } : {})} {...(testID ? { "data-testid": testID } : {})} />
  );
}
