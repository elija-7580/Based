// BSD-281: Graph und Meetings sind Reiter der Library (statt eigenem Eintrag in der Seitenleiste). Beide Ansichten zeigen oben
// dieselben Reiter; der Wechsel geht über die Route (#library, #graph), damit Zurück/Vor und ⌘K weiter passen.
// Beta-Gate (shell/beta.ts): Reiter, die der Kanal ausblendet, fehlen; bleibt nur „Pages“, entfallen die Reiter ganz.
import { featureVisible } from "../shell/beta.js";
import { BasedSwitcher } from "@based/ui/astryx";

export function LibraryTabs({ value, onNavigate }: { value: "library" | "graph" | "meetings"; onNavigate: (to: "library" | "graph" | "meetings") => void }) {
  const graph = featureVisible("graph"), meetings = featureVisible("meetings");
  if (!graph && !meetings) return null;
  return (
    <BasedSwitcher label="Library view" value={value} onChange={(v) => onNavigate(v === "graph" || v === "meetings" ? v : "library")}
      items={[{ id: "library", label: "Pages" }, ...(graph ? [{ id: "graph", label: "Graph" }] : []), ...(meetings ? [{ id: "meetings", label: "Meetings" }] : [])]} />
  );
}
