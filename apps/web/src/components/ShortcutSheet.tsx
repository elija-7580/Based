// Übersicht aller Tastenkürzel (⇧⌘/ = ⌘?, Hilfe-Menü, ⌘K „Keyboard shortcuts“). Inhalt allein aus dem
// Tastatur-Register (shell/keymap.ts); durchsuchbar, nach Stellen gruppiert.
import { BasedDialog, BasedField, BasedKeys } from "@based/ui/astryx";
import { useMemo, useState } from "react";
import { isApple } from "../shell/keyHints.js";
import { groupKeymap, searchKeymap, visibleEntries } from "../shell/keymap.js";

export function ShortcutSheet({ ai, onClose }: { ai: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupKeymap(searchKeymap(visibleEntries({ ai }), query)), [ai, query]);
  return (
    <BasedDialog open onClose={onClose} title="Keyboard shortcuts" width={760} testID="shortcut-sheet"
      subtitle={`Hold ${isApple() ? "⌘" : "Ctrl"} anywhere to see the keys for where you are.`}>
      <div className="keys-body">
        <BasedField label="Search shortcuts" labelHidden placeholder="Search shortcuts" value={query} onChange={setQuery} autoFocus />
        <div className="keys-sheet" tabIndex={0} role="region" aria-label="All shortcuts" data-arrow-nav="off">
          {groups.length === 0 ? <p className="t-desc">No shortcut matches “{query.trim()}”.</p> : null}
          <div className="keys-columns">
            {groups.map((g) => (
              <div key={g.group} className="keys-group" role="group" aria-label={g.group}>
                <div className="keys-group-title t-meta">{g.group}</div>
                {g.entries.map((e) => (
                  <div key={e.id} className="keys-row" data-key-id={e.id}>
                    <span className="keys-label">{e.label}</span>
                    <BasedKeys keys={e.keys} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </BasedDialog>
  );
}
