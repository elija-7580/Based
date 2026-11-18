// Seitenblatt (docs/design/elements.md, Abschnitt 4): an der rechten Kante, Breite 480 px, Fläche `bg`,
// `shadow-float`, schließt mit Escape und per Klick daneben. Für „Zeile öffnen“, Verlauf, Teilen.
import { Drawer, DrawerHeader } from "@astryxdesign/core/Drawer";
import type { ReactNode } from "react";

export interface BasedSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  testID?: string;
}

export function BasedSheet({ open, onClose, title, subtitle, children, testID }: BasedSheetProps) {
  const change = (o: boolean) => { if (!o) onClose(); };
  return (
    <Drawer isOpen={open} onOpenChange={change} label={title} side="end" width={480}>
      <span className="based-sheet" data-testid={testID}>
        <DrawerHeader title={title} {...(subtitle ? { subtitle } : {})} onOpenChange={change} />
        <span className="based-sheet-body">{children}</span>
      </span>
    </Drawer>
  );
}
