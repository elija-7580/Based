// Dünne Based-Wrapper um Astryx (docs/design/astryx.md): Button, Dialog, Bestätigung, Menü, Popover, Formularfeld.
// Sie legen die Based-Gewohnheiten fest (eine primäre Aktion = Tinte, Aktionen rechts unten, Fehler als Feldstatus)
// und halten die Astryx-Props aus den Views heraus. Aussehen kommt allein aus dem Theme „Based Default“
// (@based/design-tokens/astryx) – hier stehen keine Farben. Voraussetzung: die App liegt in `<Theme>`.
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Popover } from "@astryxdesign/core/Popover";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { ReactNode } from "react";
import { buttonVariant, dialogPurpose, fieldStatus, menuItems, type BasedButtonVariant, type BasedMenuItem } from "./variants.js";

export { buttonVariant, dialogPurpose, fieldStatus, menuItems } from "./variants.js";
export type { BasedButtonVariant, BasedMenuItem } from "./variants.js";

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
}

export function BasedButton({ label, variant, size = "md", type = "button", disabled = false, busy = false, icon, onClick }: BasedButtonProps) {
  return <Button label={label} variant={buttonVariant(variant)} size={size} type={type} isDisabled={disabled} isLoading={busy} icon={icon} {...(onClick ? { onClick: () => onClick() } : {})} />;
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
}

export function BasedDialog({ open, onClose, title, subtitle, children, actions, width = 440, busy, form }: BasedDialogProps) {
  const change = (isOpen: boolean) => {
    if (!isOpen && !busy) onClose();
  };
  return (
    <Dialog isOpen={open} onOpenChange={change} width={width} purpose={dialogPurpose({ busy, form })}>
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
}

/** Einzeiliges Formularfeld mit sichtbarem Label; nimmt die volle Breite seines Containers. */
export function BasedField({ label, value, onChange, type = "text", hint, placeholder, error, disabled = false, required = false, autoComplete, onEnter }: BasedFieldProps) {
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
      {...(onEnter ? { onEnter } : {})}
    />
  );
}
