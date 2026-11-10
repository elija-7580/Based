// Reine Abbildungen der Based-Wrapper auf Astryx-Props (ohne React, darum hier und getestet).

/** Based kennt vier Button-Rollen; „primary“ = Tinte, höchstens eine pro Ansicht. */
export type BasedButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type AstryxButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export function buttonVariant(v: BasedButtonVariant | undefined): AstryxButtonVariant {
  return v === "danger" ? "destructive" : (v ?? "secondary");
}

/** Wie sich ein Dialog schließen lässt: beschäftigt → gar nicht, Formular → nicht per Klick daneben, sonst frei. */
export function dialogPurpose(opts: { busy?: boolean | undefined; form?: boolean | undefined }): "required" | "form" | "info" {
  if (opts.busy) return "required";
  return opts.form ? "form" : "info";
}

/** Fehlertext eines Formularfelds als Astryx-Status. */
export function fieldStatus(error: string | undefined): { type: "error"; message: string } | undefined {
  const message = error?.trim();
  return message ? { type: "error", message } : undefined;
}

export interface BasedMenuItem {
  /** Fehlt `label`, ist der Eintrag eine Trennlinie. */
  label?: string;
  description?: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
}

export type AstryxMenuOption =
  | { type: "divider" }
  | { label: string; description?: string; onClick?: () => void; isDisabled?: boolean; variant?: "destructive" };

/** Based-Menüeinträge → `items` von DropdownMenu; führende, doppelte und abschließende Trennlinien fallen weg. */
export function menuItems(items: readonly BasedMenuItem[]): AstryxMenuOption[] {
  const out: AstryxMenuOption[] = [];
  for (const it of items) {
    if (it.label === undefined) {
      const last = out[out.length - 1];
      if (out.length && !(last && "type" in last)) out.push({ type: "divider" });
      continue;
    }
    out.push({
      label: it.label,
      ...(it.description ? { description: it.description } : {}),
      ...(it.onSelect ? { onClick: it.onSelect } : {}),
      ...(it.disabled ? { isDisabled: true } : {}),
      ...(it.danger ? { variant: "destructive" as const } : {}),
    });
  }
  const last = out[out.length - 1];
  if (last && "type" in last) out.pop();
  return out;
}
