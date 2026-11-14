// BSD-407 Teil 5: Reiter, die einen Bereich an Ort und Stelle umschalten (Meeting: Summary / Notes / Transcript).
// Astryx-TabList im WAI-ARIA-Muster (role tablist/tab, aria-selected, Pfeiltasten), Aussehen aus dem Theme.
import { Tab, TabList } from "@astryxdesign/core/TabList";

export interface BasedTab {
  id: string;
  label: string;
  /** ID des Bereichs, den der Reiter zeigt (aria-controls). */
  panelId?: string;
}

export interface BasedTabsProps {
  /** Name der Reiterleiste für Screenreader. */
  label: string;
  tabs: readonly BasedTab[];
  value: string;
  onChange: (id: string) => void;
  size?: "sm" | "md";
}

export function BasedTabs({ label, tabs, value, onChange, size = "sm" }: BasedTabsProps) {
  return (
    <TabList role="tablist" aria-label={label} value={value} onChange={onChange} size={size}>
      {tabs.map((t) => <Tab key={t.id} value={t.id} label={t.label} {...(t.panelId ? { panelId: t.panelId } : {})} />)}
    </TabList>
  );
}
