// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-619: Hinweis „Moved to Trash · Undo“ nach dem Löschen einer Seite (BasedToast, 4 s) und ⌘Z außerhalb eines
// Textfelds: holt die zuletzt gelöschten Seiten zurück und öffnet die Seite wieder, die beim Löschen offen war.
// Editor, Datenbank-Ansichten und Whiteboard haben ihr eigenes ⌘Z – sie behandeln die Taste vorher (defaultPrevented).
import { BasedButton, BasedToast } from "@based/ui/astryx";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { lastTrashed, subscribeTrashed, takeTrashed, trashedText } from "../shell/trashUndo.js";
import type { StoreClient } from "../worker/client.js";

function inTextOrOwnUndo(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement || t instanceof HTMLSelectElement) return true;
  // Bereiche mit eigenem Undo, auch wenn gerade kein Textfeld den Fokus hat (Blockauswahl, Tabelle, Board)
  return t.closest(".bx2-editor, .shell-database, .wb-root, [data-own-undo]") !== null;
}

export function TrashUndo({ client, onOpenPage }: { client: StoreClient; onOpenPage: (id: string) => void }) {
  const trashed = useSyncExternalStore(subscribeTrashed, lastTrashed);
  // Der Hinweis gehört zu einem Löschen; nach 4 s geht er, ⌘Z bleibt bis zum nächsten Löschen möglich.
  const [shown, setShown] = useState<number>();
  useEffect(() => { if (trashed) setShown(trashed.seq); }, [trashed]);

  const undo = useCallback(() => {
    const t = takeTrashed();
    setShown(undefined);
    if (!t) return;
    void client.command({ op: "restore", ids: t.ids }).then(() => { if (t.reopen) onOpenPage(t.reopen); });
  }, [client, onOpenPage]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
      if (!lastTrashed() || inTextOrOwnUndo(e.target)) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo]);

  const hide = useCallback(() => setShown(undefined), []);
  const open = trashed !== undefined && shown === trashed.seq;
  return (
    <BasedToast open={open} onClose={hide} testID="trash-toast"
      action={<BasedButton label="Undo" variant="ghost" onClick={undo} />}>
      {trashed ? trashedText(trashed.ids.length) : ""}
    </BasedToast>
  );
}
