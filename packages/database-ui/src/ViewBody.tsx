// BSD-155: Inhalt einer Ansicht je Layout. Die Abfrage (Filter, Suche, Sortierung, Gruppen) läuft im Kern
// und nur neu, wenn sich die Datenbank (Version), die Ansicht oder die Suche ändert.
import { useMemo } from "react";
import type { DatabaseView, QueryResult } from "@based/core";
import { useDB } from "./context.js";
import { BoardLayout } from "./layouts/Board.js";
import { ChartLayout } from "./layouts/Chart.js";
import { DashboardLayout } from "./layouts/Dashboard.js";
import { GalleryLayout, ListLayout } from "./layouts/List.js";
import { EmptyState } from "./layouts/shared.js";
import { TableLayout } from "./layouts/Table.js";

/** Abfrageergebnis einer Ansicht (memoisiert auf Version/Ansicht/Suche). */
export function useQuery(view: DatabaseView, search: string): QueryResult {
  const { engine, version } = useDB();
  return useMemo(() => engine.run(view, search), [engine, version, view, search]);
}

export function ViewBody({ view, search, compact, requestEdit }: { view: DatabaseView; search: string; compact?: boolean; requestEdit?: { rowID: string } | undefined }) {
  const result = useQuery(view, search);
  switch (view.type) {
    case "table": return <TableLayout view={view} result={result} requestEdit={requestEdit} />;
    case "board": return <BoardLayout view={view} result={result} />;
    case "list": return <ListLayout view={view} result={result} />;
    case "gallery": return <GalleryLayout view={view} result={result} />;
    case "chart": return <ChartLayout view={view} result={result} {...(compact ? { height: 240 } : {})} />;
    case "dashboard": return <DashboardLayout view={view} />;
    case "calendar": case "timeline":
      return (
        <EmptyState>
          <strong>{view.type === "calendar" ? "Calendar" : "Timeline"}</strong> is coming soon ({result.rows.length} pages). Switch the layout in View settings to see them.
        </EmptyState>
      );
    default:
      return <EmptyState>This layout (“{view.type}”) isn’t available here yet ({result.rows.length} pages).</EmptyState>;
  }
}
