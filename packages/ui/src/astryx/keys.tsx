// Tastenkürzel als Tastenkappen (Astryx Kbd). Nimmt die Schreibweise des Tastatur-Registers („Mod+Shift+K“,
// mehrere mit „ / “) und zeigt je Plattform ⇧⌘K bzw. Ctrl+Shift+K.
import { Kbd } from "@astryxdesign/core/Kbd";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { Fragment } from "react";
import { parseCombo } from "../keys.js";

const KBD_KEY: Record<string, string> = { arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", "+": "plus", arrows: "↑↓←→" };

/** Register-Schreibweise → Astryx-Kbd („mod+shift+k“). */
export function kbdKeys(combo: string): string {
  const c = parseCombo(combo);
  return [...(c.mod ? ["mod"] : []), ...(c.ctrl ? ["ctrl"] : []), ...(c.alt ? ["alt"] : []), ...(c.shift ? ["shift"] : []), KBD_KEY[c.key] ?? c.key].join("+");
}

export function BasedKeys({ keys }: { keys: string }) {
  const all = keys.split(" / ");
  if (all.length === 1) return <Kbd keys={kbdKeys(all[0]!)} />;
  // Mehrere Kombinationen: mit Zusatztasten durch „/“ getrennt (sonst liest sich „F6 ⇧ F6“ wie eine einzige);
  // einzelne Tasten (↑ ↓ ← →) stehen einfach nebeneinander.
  const combos = all.some((k) => k.includes("+") && k.trim() !== "+");
  return (
    <HStack gap={1} vAlign="center" style={{ flexWrap: "nowrap", justifyContent: "flex-end", flex: "none" }}>
      {all.map((k, i) => (
        <Fragment key={k}>
          {combos && i > 0 ? <Text type="supporting" color="secondary">/</Text> : null}
          <Kbd keys={kbdKeys(k)} />
        </Fragment>
      ))}
    </HStack>
  );
}
