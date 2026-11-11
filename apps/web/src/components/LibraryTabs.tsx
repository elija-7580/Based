// BSD-281: Graph ist ein Reiter der Library (statt eigenem Eintrag in der Seitenleiste). Beide Ansichten zeigen oben
// dieselben Reiter; der Wechsel geht über die Route (#library, #graph), damit Zurück/Vor und ⌘K weiter passen.
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";

export function LibraryTabs({ value, onNavigate }: { value: "library" | "graph"; onNavigate: (to: "library" | "graph") => void }) {
  return (
    <SegmentedControl label="Library view" size="sm" value={value} onChange={(v) => onNavigate(v === "graph" ? "graph" : "library")}>
      <SegmentedControlItem value="library" label="Pages" />
      <SegmentedControlItem value="graph" label="Graph" />
    </SegmentedControl>
  );
}
