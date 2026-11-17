// BSD-281: Graph und Meetings sind Reiter der Library (statt eigenem Eintrag in der Seitenleiste). Beide Ansichten zeigen oben
// dieselben Reiter; der Wechsel geht über die Route (#library, #graph), damit Zurück/Vor und ⌘K weiter passen.
// Beta-Gate (shell/beta.ts): Reiter, die der Kanal ausblendet, fehlen; bleibt nur „Pages“, entfallen die Reiter ganz.
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { featureVisible } from "../shell/beta.js";

export function LibraryTabs({ value, onNavigate }: { value: "library" | "graph" | "meetings"; onNavigate: (to: "library" | "graph" | "meetings") => void }) {
  const graph = featureVisible("graph"), meetings = featureVisible("meetings");
  if (!graph && !meetings) return null;
  return (
    <SegmentedControl label="Library view" value={value} onChange={(v) => onNavigate(v === "graph" || v === "meetings" ? v : "library")}>
      <SegmentedControlItem value="library" label="Pages" />
      {graph ? <SegmentedControlItem value="graph" label="Graph" /> : null}
      {meetings ? <SegmentedControlItem value="meetings" label="Meetings" /> : null}
    </SegmentedControl>
  );
}
