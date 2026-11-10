// Phase 2: @based/editor in den PageEditor-Steckplatz der Shell. Theme folgt dem Wurzel-Attribut data-theme;
// Inline-Datenbanken rendert der DatabaseView-Steckplatz (sobald @based/database-ui eingesteckt ist), Gleichungen
// KaTeX offline (BSD-10, src/equation.tsx). Erwähnungen, Seitensuche und Backlinks kommen aus dem Store-Worker
// (shell/pageDirectory.ts); Synced Blocks von anderen Seiten holt `loadSynced` in die Seiten-Replik.
import { useEffect, useMemo, useState } from "react";
import { PageEditor, type DatabaseRenderProps, type EquationRenderProps, type MeetingHost } from "@based/editor";
import { assets } from "./assetBridge.js";
import "./assets.css";
import { Backlinks } from "./components/Backlinks.js";
import { Equation } from "./equation.js";
import { createMeetingHost } from "./meeting/host.js";
import { ShellPageDirectory } from "./shell/pageDirectory.js";
import { slots, type PageEditorProps } from "./slots.js";
import type { StoreClient } from "./worker/client.js";

let shellClient: StoreClient | undefined;
let directory: ShellPageDirectory | undefined;
let meeting: MeetingHost | undefined;

/** Der Editor-Steckplatz braucht den Store-Client (Seitensuche, Backlinks). Einmal beim Start setzen (main.tsx). */
export function connectEditor(client: StoreClient) {
  shellClient = client;
  directory = new ShellPageDirectory(client);
  meeting = createMeetingHost(client);
}

function useRootTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const o = new MutationObserver(() => setTheme(read()));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => o.disconnect();
  }, []);
  return theme;
}

export function ShellPageEditor({ store, pageID, readOnly, onOpenPage }: PageEditorProps) {
  const theme = useRootTheme();
  const client = shellClient;
  const renderDatabase = (p: DatabaseRenderProps) => {
    const View = slots.DatabaseView;
    return View ? <View store={store} blockID={p.blockID} databaseID={p.databaseID} readOnly={readOnly} onOpenPage={onOpenPage} /> : null;
  };
  const renderEquation = (p: EquationRenderProps) => <Equation expression={p.expression} displayMode={p.displayMode} />;
  const files = assets();
  const loadSynced = useMemo(() => (client ? (source: string) => client.includeSynced(pageID, source) : undefined), [client, pageID]);
  const hideBacklinks = store.blocks.get(pageID)?.props?.format?.hideBacklinks === true;
  return (
    <div className="shell-editor">
      <PageEditor store={store} pageID={pageID} editable={!readOnly} onOpenPage={onOpenPage} theme={theme} renderDatabase={renderDatabase} renderEquation={renderEquation}
        {...(directory ? { pages: directory } : {})} {...(loadSynced ? { loadSynced } : {})} {...(meeting ? { meeting } : {})}
        {...(files ? { uploadFile: (f: File) => files.uploadFile(f), resolveFileUrl: (u: string) => files.resolveFileUrl(u) } : {})} />
      {client && !hideBacklinks ? <div className="shell-backlinks"><Backlinks client={client} pageID={pageID} onOpenPage={onOpenPage} /></div> : null}
    </div>
  );
}
