// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { Icon } from "../icons.js";
import { pageTint } from "../shell/pageTint.js";

/** Seiten-Kachel (docs/design/elements.md): steht überall dort, wo eine Seite oder Datenbank kein eigenes Icon hat. */
export function PageTile({ id, database }: { id: string; database?: boolean }) {
  return <span className="page-tile" data-tint={pageTint(id)} data-testid="page-tile"><Icon name={database ? "database" : "page"} size={14} /></span>;
}
