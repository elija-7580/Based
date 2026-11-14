// Dünne Based-Wrapper um Astryx (docs/design/astryx.md): Button, Dialog, Bestätigung, Menü, Popover, Formularfeld.
// Sie legen die Based-Gewohnheiten fest (eine primäre Aktion = Tinte, Aktionen rechts unten, Fehler als Feldstatus)
// und halten die Astryx-Props aus den Views heraus. Aussehen kommt allein aus dem Theme „Based Default“
// (@based/design-tokens/astryx) – hier stehen keine Farben. Voraussetzung: die App liegt in `<Theme>`.
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Popover } from "@astryxdesign/core/Popover";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { buttonVariant, dialogPurpose, fieldStatus, menuItems, type BasedButtonVariant, type BasedMenuItem } from "./variants.js";

export { buttonVariant, dialogPurpose, fieldStatus, menuItems } from "./variants.js";
export type { BasedButtonVariant, BasedMenuItem } from "./variants.js";
export { BasedTabs, type BasedTab, type BasedTabsProps } from "./tabs.js";
export { BasedToken, tokenColor, type BasedTokenColor, type BasedTokenProps } from "./token.js";

export interface BasedButtonProps {
  label: string;
  /** „primary“ höchstens einmal pro Ansicht. Standard: secondary. */
  variant?: BasedButtonVariant;
  size?: "sm" | "md" | "lg";
  type?: "button" | "submit";
  disabled?: boolean;
  /** Zeigt den Spinner und sperrt erneutes Auslösen. */
  busy?: boolean;
  icon?: ReactNode;
  onClick?: () => void;
  /** Genauerer Name für Screenreader, wenn das Label allein mehrdeutig ist (z. B. „Link“ in einer Liste). */
  ariaLabel?: string;
}

export function BasedButton({ label, variant, size = "md", type = "button", disabled = false, busy = false, icon, onClick, ariaLabel }: BasedButtonProps) {
  return <Button label={label} variant={buttonVariant(variant)} size={size} type={type} isDisabled={disabled} isLoading={busy} icon={icon} {...(onClick ? { onClick: () => onClick() } : {})} {...(ariaLabel ? { "aria-label": ariaLabel } : {})} />;
}

export interface BasedIconButtonProps {
  /** Name für Screenreader (Pflicht – der Knopf zeigt nur ein Icon). */
  label: string;
  icon: ReactNode;
  /** Tooltip, Standard: das Label; mit Tastenkürzel, z. B. „Back (⌘[)“. */
  tooltip?: string;
  variant?: "ghost" | "secondary";
  size?: "sm" | "md";
  disabled?: boolean;
  /** Umschalter (z. B. Favorit): aria-pressed. */
  pressed?: boolean;
  /** Öffnet ein Menü: aria-haspopup, aria-expanded und data-menu-trigger (Klick daneben schließt nicht doppelt). */
  menu?: { expanded: boolean };
  /** Bekommt den Knopf (z. B. als Anker für ein Menü). */
  onClick?: (el: HTMLElement) => void;
  testID?: string;
}

/** Icon-Knopf (Kopfzeile, Schließen-×, Werkzeugleisten) – BSD-350. Klickfläche ≥ 24 px, Name und Tooltip immer gesetzt. */
export function BasedIconButton({ label, icon, tooltip, variant = "ghost", size = "sm", disabled = false, pressed, menu, onClick, testID }: BasedIconButtonProps) {
  return (
    <IconButton label={label} tooltip={tooltip ?? label} variant={variant} size={size} icon={icon} isDisabled={disabled}
      {...(pressed !== undefined ? { "aria-pressed": pressed } : {})} {...(testID ? { "data-testid": testID } : {})}
      {...(menu ? { "aria-haspopup": "menu" as const, "aria-expanded": menu.expanded, "data-menu-trigger": "" } : {})}
      {...(onClick ? { onClick: (e: { currentTarget: HTMLElement }) => onClick(e.currentTarget) } : {})} />
  );
}

export interface BasedDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Aktionen, rechtsbündig unter dem Inhalt (primäre Aktion zuletzt). */
  actions?: ReactNode;
  width?: number;
  /** Solange etwas läuft, lässt sich der Dialog nicht schließen. */
  busy?: boolean;
  /** Formular-Dialog: ein Klick daneben schließt nach einer Eingabe nicht mehr. */
  form?: boolean;
  testID?: string;
}

export function BasedDialog({ open, onClose, title, subtitle, children, actions, width = 440, busy, form, testID }: BasedDialogProps) {
  const change = (isOpen: boolean) => {
    if (!isOpen && !busy) onClose();
  };
  return (
    <Dialog isOpen={open} onOpenChange={change} width={width} purpose={dialogPurpose({ busy, form })} {...(testID ? { "data-testid": testID } : {})}>
      <DialogHeader title={title} {...(subtitle ? { subtitle } : {})} hasDivider={false} {...(busy ? {} : { onOpenChange: change })} />
      <VStack gap={4} style={{ paddingInline: "var(--spacing-4)" }}>
        {children}
        {actions ? <HStack gap={2} hAlign="end">{actions}</HStack> : null}
      </VStack>
    </Dialog>
  );
}

export interface BasedConfirmProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Was passiert – in einem Satz, mit der Folge. */
  description: string;
  actionLabel: string;
  onConfirm: () => void | Promise<void>;
  /** Standard: zerstörend (danger). */
  danger?: boolean;
  busy?: boolean;
}

/** Rückfrage vor einer Aktion, die sich nicht zurücknehmen lässt. Schließt nach `onConfirm` selbst. */
export function BasedConfirm({ open, onClose, title, description, actionLabel, onConfirm, danger = true, busy = false }: BasedConfirmProps) {
  return (
    <AlertDialog
      isOpen={open}
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      title={title}
      description={description}
      actionLabel={actionLabel}
      actionVariant={danger ? "destructive" : "primary"}
      isActionLoading={busy}
      onAction={async () => {
        await onConfirm();
        onClose();
      }}
    />
  );
}

export interface BasedMenuProps {
  /** Beschriftung des Auslösers (Button). */
  label: string;
  items: readonly BasedMenuItem[];
  variant?: BasedButtonVariant;
  size?: "sm" | "md" | "lg";
  align?: "start" | "end";
}

/** Menü an einem Button: Einträge mit optionaler Beschreibung, Trennlinien (`{}`), zerstörende Einträge in danger. */
export function BasedMenu({ label, items, variant = "secondary", size = "md", align = "start" }: BasedMenuProps) {
  return <DropdownMenu button={{ label, variant: buttonVariant(variant), size }} items={menuItems(items)} alignment={align} />;
}

export interface BasedPopoverProps {
  /** Name für Screenreader. */
  label: string;
  /** Auslöser: muss ein Button sein (z. B. BasedButton). */
  trigger: ReactNode;
  children: ReactNode;
  width?: number;
  align?: "start" | "center" | "end";
}

export function BasedPopover({ label, trigger, children, width, align = "start" }: BasedPopoverProps) {
  return (
    <Popover label={label} content={children} alignment={align} padding={4} {...(width ? { width } : {})}>
      {trigger}
    </Popover>
  );
}

export interface BasedFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password" | "email" | "url" | "search";
  hint?: string;
  placeholder?: string;
  /** Fehlertext; leer/undefined = kein Fehler. */
  error?: string;
  disabled?: boolean;
  required?: boolean;
  autoComplete?: string;
  onEnter?: () => void;
  /** Label nur für Screenreader (z. B. Zelleneditor in einer Tabelle, BSD-375). */
  labelHidden?: boolean;
  /** Zugriff aufs Eingabefeld (Fokus, Cursor setzen). */
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  inputMode?: "text" | "decimal" | "numeric" | "email" | "url" | "tel" | "search";
  autoFocus?: boolean;
}

/** Einzeiliges Formularfeld mit sichtbarem Label; nimmt die volle Breite seines Containers. */
export function BasedField({ label, value, onChange, type = "text", hint, placeholder, error, disabled = false, required = false, autoComplete, onEnter, labelHidden, inputRef, onKeyDown, inputMode, autoFocus }: BasedFieldProps) {
  const status = fieldStatus(error);
  return (
    <TextInput
      label={label}
      value={value}
      onChange={(v) => onChange(v)}
      type={type}
      width="100%"
      isDisabled={disabled}
      isRequired={required}
      statusVariant="detached"
      {...(hint ? { description: hint } : {})}
      {...(placeholder ? { placeholder } : {})}
      {...(status ? { status } : {})}
      {...(autoComplete ? { autoComplete } : {})}
      {...(type === "url" ? { inputMode: "url" as const, hasSpellCheck: false } : {})}
      {...(inputMode ? { inputMode } : {})}
      {...(onEnter ? { onEnter } : {})}
      {...(labelHidden ? { isLabelHidden: true } : {})}
      {...(inputRef ? { ref: inputRef } : {})}
      {...(onKeyDown ? { onKeyDown } : {})}
      {...(autoFocus ? { hasAutoFocus: true } : {})}
    />
  );
}
