// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// Feedback 20. 11.: Home ohne AI und ohne Home-Seite. Früher rückte nach Löschen oder Zurücksetzen sofort die nächste
// Seite nach; jetzt bleibt Home leer, bis man selbst eine Seite wählt. Kopf wie andere App-Screens (Trash), darunter
// die drei Wege: Seite wählen, neue Seite, suchen.
import { BasedButton, BasedKeys } from "@based/ui/astryx";
import { useState } from "react";
import { PagePickerDialog } from "../components/MoveDialog.js";
import { Icon } from "../icons.js";
import { startPage } from "../shell/storage.js";
import type { ShellState } from "../worker/client.js";

export function HomePlain({ state, onNewPage, onQuickFind }: { state: ShellState; onNewPage: () => void; onQuickFind: () => void }) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="content" data-testid="home-plain">
      <div className="column">
        <header className="trash-head">
          <div className="trash-title"><h1 className="t-heading">Home</h1></div>
        </header>
        <p className="t-desc trash-hint">Pick a page to open here whenever you go Home. You can change it any time with a right-click on a page.</p>
        <div className="home-plain-actions">
          <BasedButton label="Choose a page…" variant="primary" icon={<Icon name="home" size={16} />} onClick={() => setPicking(true)} />
          <BasedButton label="New page" icon={<Icon name="plus" size={16} />} onClick={onNewPage} />
          <span className="home-plain-search">
            <BasedButton label="Search" variant="ghost" icon={<Icon name="search" size={16} />} onClick={onQuickFind} />
            <BasedKeys keys="Mod+K" />
          </span>
        </div>
      </div>
      {picking ? (
        <PagePickerDialog state={state} title="Choose Home" onClose={() => setPicking(false)}
          onPick={(p) => { startPage.set(p.id); setPicking(false); }} />
      ) : null}
    </div>
  );
}
