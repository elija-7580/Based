// Phase 2: @based/database-ui im DatabaseView-Steckplatz der Shell. Ganze Datenbankseiten zeigen den Titel schon in
// der Shell (showTitle aus), Inline-Datenbanken im Editor mit Titel und begrenzter Höhe.
// Zeilen öffnen je Ansicht als Side Peek, Center Peek oder ganze Seite (database/RowPeek.tsx); die Formular-Ansicht
// kommt aus Astryx-Formkomponenten (database/FormView.tsx).
import { useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { attachWheelPassThrough } from "./database/wheelPassThrough.js";
import { weekStartPref } from "./shell/storage.js";
import { plainText } from "@based/core";
import { DatabaseView, type FormRenderProps, type PeekOptions, type RowActions } from "@based/database-ui";
import "@based/database-ui/styles.css";
import { FormView } from "./database/FormView.js";
import { InPeek, RowPeek } from "./database/RowPeek.js";
import { asNewTabs, wantsNewTab } from "./shell/newTabIntent.js";
import { routeToHash } from "./shell/router.js";
import { assets } from "./assetBridge.js";
import { chatController } from "./chat/runtime.js";
import { editorClient } from "./editorSlot.js";
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

export function ShellDatabaseView({ store, blockID, databaseID, readOnly, onOpenPage, asPage }: DatabaseViewProps) {
  // Ganze Seite: Datenbankseite, oder eine Inline-Datenbank, die per „Open as full page“ als Seite offen ist (BSD-255).
  const fullPage = store.blocks.get(blockID)?.type === "databasePage" || asPage === true;
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
  // BSD-225 Teil 2: „Autofill with AI“ im Property-Menü über das eingestellte Modell (wie „Ask AI“ im Editor)
  const ai = useMemo(() => {
    const client = editorClient();
    return client ? { write: (system: string, prompt: string, signal: AbortSignal) => chatController(client).write(system, prompt, signal), available: () => chatController(client).canWrite() } : undefined;
  }, []);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => (!fullPage && wrap.current ? attachWheelPassThrough(wrap.current) : undefined), [fullPage]);
  return (
    <div ref={wrap} className={fullPage ? "shell-database full" : "shell-database inline"}>
      <DatabaseView store={store} databaseID={databaseID} blockID={blockID} readOnly={readOnly} onOpenPage={onOpenPage} showTitle={!fullPage} inline={!fullPage && !nested} {...(fullPage || !nested ? {} : { height: "calc(var(--space-8) * 7)" })} peek={peek} renderForm={renderForm} files={files} weekStart={weekStart} rowActions={rowActions} ai={ai} />
    </div>
  );
}
