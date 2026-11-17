// Kurzanzeige beim langen Halten von ⌘ (Strg): die Tasten, die an der Stelle gelten, an der man gerade ist
// (Seitenleiste, Text, ausgewählte Blöcke, Datenbank-Tabelle, Menü …), dazu das Wichtigste von überall. Die Stelle
// ergibt sich aus dem Fokus in dem Moment, in dem die Anzeige erscheint (shell/keymap.ts scopeOf).
import { BasedKeys } from "@based/ui/astryx";
import { useMemo, useSyncExternalStore } from "react";
import { keyHints } from "../shell/keyHints.js";
import { hudFor, scopeOf } from "../shell/keymap.js";

export function ShortcutHud({ ai }: { ai: boolean }) {
  const shown = useSyncExternalStore(keyHints.subscribe, keyHints.get);
  // `shown` ist der Auslöser: die Stelle gilt für den Moment, in dem die Anzeige erscheint
  const groups = useMemo(() => (shown ? hudFor(scopeOf(document.activeElement), { ai }) : []), [shown, ai]);
  if (!shown) return null;
  return (
    <div className="keys-hud" aria-hidden="true" data-testid="shortcut-hud">
      {groups.map((g) => (
        <div key={g.title} className="keys-hud-group">
          <div className="keys-group-title t-meta">{g.title}</div>
          {g.entries.map((e) => (
            <div key={e.id} className="keys-row">
              <span className="keys-label">{e.label}</span>
              <BasedKeys keys={e.keys} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
