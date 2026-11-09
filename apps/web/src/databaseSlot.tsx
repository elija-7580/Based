// Phase 2: @based/database-ui im DatabaseView-Steckplatz der Shell. Ganze Datenbankseiten zeigen den Titel schon in
// der Shell (showTitle aus), Inline-Datenbanken im Editor mit Titel und begrenzter Höhe.
import { DatabaseView } from "@based/database-ui";
import "@based/database-ui/styles.css";
import type { DatabaseViewProps } from "./slots.js";

export function ShellDatabaseView({ store, blockID, databaseID, readOnly, onOpenPage }: DatabaseViewProps) {
  const fullPage = store.blocks.get(blockID)?.type === "databasePage";
  return (
    <div className={fullPage ? "shell-database full" : "shell-database inline"}>
      <DatabaseView store={store} databaseID={databaseID} blockID={blockID} readOnly={readOnly} onOpenPage={onOpenPage} showTitle={!fullPage} height={fullPage ? "100%" : "calc(var(--space-8) * 7)"} />
    </div>
  );
}
