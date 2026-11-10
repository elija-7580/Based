// Phase 2: @based/database-ui im DatabaseView-Steckplatz der Shell. Ganze Datenbankseiten zeigen den Titel schon in
// der Shell (showTitle aus), Inline-Datenbanken im Editor mit Titel und begrenzter Höhe.
// Zeilen öffnen je Ansicht als Side Peek, Center Peek oder ganze Seite (database/RowPeek.tsx); die Formular-Ansicht
// kommt aus Astryx-Formkomponenten (database/FormView.tsx).
import { useContext, useMemo, useSyncExternalStore } from "react";
import { weekStartPref } from "./shell/storage.js";
import { plainText } from "@based/core";
import { DatabaseView, type FormRenderProps, type PeekOptions, type RowActions } from "@based/database-ui";
import "@based/database-ui/styles.css";
import { FormView } from "./database/FormView.js";
import { InPeek, RowPeek } from "./database/RowPeek.js";
import { asNewTabs, wantsNewTab } from "./shell/newTabIntent.js";
import { routeToHash } from "./shell/router.js";
import { assets } from "./assetBridge.js";
import { ASSET_URL_PREFIX } from "@based/editor";
import type { DatabaseViewProps } from "./slots.js";

/** Offener Peek je Datenbank-Block, pro Browser-Tab (überlebt Neuladen). */
function peekStorage(blockID: string): NonNullable<PeekOptions["storage"]> {
  const key = "based.peek." + blockID;
  return {
    get() { try { return sessionStorage.getItem(key); } catch { return null; } },
    set(v) { try { if (v === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, v); } catch { /* nur für diese Sitzung */ } },
  };
}

const renderForm = (p: FormRenderProps) => <FormView {...p} />;

export function ShellDatabaseView({ store, blockID, databaseID, readOnly, onOpenPage }: DatabaseViewProps) {
  const fullPage = store.blocks.get(blockID)?.type === "databasePage";
  // BSD-205: Wochenbeginn aus Einstellungen → Language & region (sonst aus der Sprache des Systems).
  const weekStart = useSyncExternalStore(weekStartPref.subscribe, weekStartPref.get);
  const nested = useContext(InPeek);
  const peek = useMemo<PeekOptions | undefined>(() => (nested ? undefined : {
    storage: peekStorage(blockID),
    bypass: wantsNewTab,
    render: (p) => <RowPeek {...p} databaseTitle={plainText(store.databases.get(databaseID)?.title) || "Untitled"} readOnly={readOnly} onOpenPage={onOpenPage} />,
  }), [nested, blockID, databaseID, store, readOnly, onOpenPage]);
  // BSD-213: Sammelaktionen für ausgewählte Zeilen – in Hintergrund-Tabs öffnen, Links kopieren.
  const rowActions = useMemo<RowActions>(() => ({
    ...(onOpenPage ? { openInTabs: (ids: string[]) => asNewTabs(() => ids.forEach((id) => onOpenPage(id))) } : {}),
    copyLinks: (ids: string[]) => {
      const text = ids.map((id) => { const u = new URL(location.href); u.hash = routeToHash({ name: "page", id }); return u.toString(); }).join("\n");
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    },
  }), [onOpenPage]);
  const files = useMemo(() => {
    const a = assets();
    return a ? { upload: async (f: File) => (await a.uploadFile(f)).slice(ASSET_URL_PREFIX.length), open: (id: string) => a.resolveFileUrl(ASSET_URL_PREFIX + id) } : undefined;
  }, []);
  return (
    <div className={fullPage ? "shell-database full" : "shell-database inline"}>
      <DatabaseView store={store} databaseID={databaseID} blockID={blockID} readOnly={readOnly} onOpenPage={onOpenPage} showTitle={!fullPage} height={fullPage ? "100%" : "calc(var(--space-8) * 7)"} peek={peek} renderForm={renderForm} files={files} weekStart={weekStart} rowActions={rowActions} />
    </div>
  );
}
