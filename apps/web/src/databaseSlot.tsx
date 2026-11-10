// Phase 2: @based/database-ui im DatabaseView-Steckplatz der Shell. Ganze Datenbankseiten zeigen den Titel schon in
// der Shell (showTitle aus), Inline-Datenbanken im Editor mit Titel und begrenzter Höhe.
// Zeilen öffnen je Ansicht als Side Peek, Center Peek oder ganze Seite (database/RowPeek.tsx); die Formular-Ansicht
// kommt aus Astryx-Formkomponenten (database/FormView.tsx).
import { useContext, useMemo } from "react";
import { plainText } from "@based/core";
import { DatabaseView, type PeekOptions } from "@based/database-ui";
import "@based/database-ui/styles.css";
import { InPeek, RowPeek } from "./database/RowPeek.js";
import { wantsNewTab } from "./shell/newTabIntent.js";
import type { DatabaseViewProps } from "./slots.js";

/** Offener Peek je Datenbank-Block, pro Browser-Tab (überlebt Neuladen). */
function peekStorage(blockID: string): NonNullable<PeekOptions["storage"]> {
  const key = "based.peek." + blockID;
  return {
    get() { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(v) { try { if (v === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, v); } catch { /* nur für diese Sitzung */ } },
  };
}

export function ShellDatabaseView({ store, blockID, databaseID, readOnly, onOpenPage }: DatabaseViewProps) {
  const fullPage = store.blocks.get(blockID)?.type === "databasePage";
  const nested = useContext(InPeek);
  const peek = useMemo<PeekOptions | undefined>(() => (nested ? undefined : {
    storage: peekStorage(blockID),
    bypass: wantsNewTab,
    render: (p) => <RowPeek {...p} databaseTitle={plainText(store.databases.get(databaseID)?.title) || "Untitled"} readOnly={readOnly} onOpenPage={onOpenPage} />,
  }), [nested, blockID, databaseID, store, readOnly, onOpenPage]);
  return (
    <div className={fullPage ? "shell-database full" : "shell-database inline"}>
      <DatabaseView store={store} databaseID={databaseID} blockID={blockID} readOnly={readOnly} onOpenPage={onOpenPage} showTitle={!fullPage} height={fullPage ? "100%" : "calc(var(--space-8) * 7)"} peek={peek} />
    </div>
  );
}
