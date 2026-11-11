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
import { createMeetingHost, type WebMeetingHost } from "./meeting/host.js";
import { chatController } from "./chat/runtime.js";
import { editorAI } from "./editorAI.js";
import { ShellPageDirectory } from "./shell/pageDirectory.js";
import { slots, type PageEditorProps } from "./slots.js";
import type { StoreClient } from "./worker/client.js";
import { WorkerYDocStore } from "./worker/ydocStore.js";
import { createCollab, pageCollab } from "./collab.js";
import { syncConfig } from "./shell/storage.js";
import type { CollabBinder } from "@based/editor";

let shellClient: StoreClient | undefined;
let directory: ShellPageDirectory | undefined;
let meeting: WebMeetingHost | undefined;

/** BSD-281: die Aufnahme-Pille in der Seitenleiste liest den Zustand der laufenden Aufnahme. */
export const meetingHost = (): WebMeetingHost | undefined => meeting;
let docStore: WorkerYDocStore | undefined;
let collab: CollabBinder | undefined;

/** Der Editor-Steckplatz braucht den Store-Client (Seitensuche, Backlinks). Einmal beim Start setzen (main.tsx). */
export function connectEditor(client: StoreClient) {
  shellClient = client;
  directory = new ShellPageDirectory(client);
  meeting = createMeetingHost(client);
  docStore = new WorkerYDocStore(client);
  collab = createCollab(docStore, () => syncConfig.get());
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
  const databases = useMemo(() => (client ? {
    list: async (q: string) => (await client.listDatabases(q)).map((d) => ({ id: d.id, title: d.title, path: d.path })),
    include: (id: string) => client.includeDatabase(pageID, id),
  } : undefined), [client, pageID]);
  // BSD-220: Echtzeit-Text nur, wenn eingeschaltet (beim Öffnen der Seite entschieden).
  const collabOn = syncConfig.get()?.collab === true;
  const pageCollabSource = useMemo(() => (collab && collabOn ? pageCollab(collab, pageID) : undefined), [pageID, collabOn]);
  // BSD-225: „Ask AI“ über die Chat-Engine (Modell aus Einstellungen → Agents & AI; in Tests die Skript-Engine).
  const ai = useMemo(() => (client ? editorAI((system, prompt, signal) => chatController(client).write(system, prompt, signal), () => chatController(client).canWrite()) : undefined), [client]);
  const copyPages = useMemo(() => (client ? (ids: string[]) => client.command({ op: "duplicate", ids }) : undefined), [client]);
  const hideBacklinks = store.blocks.get(pageID)?.props?.format?.hideBacklinks === true;
  return (
    <div className="shell-editor">
      <PageEditor store={store} pageID={pageID} editable={!readOnly} onOpenPage={onOpenPage} theme={theme} renderDatabase={renderDatabase} renderEquation={renderEquation}
        {...(directory ? { pages: directory } : {})} {...(loadSynced ? { loadSynced } : {})} {...(meeting ? { meeting } : {})} {...(docStore ? { docStore } : {})} {...(pageCollabSource ? { collab: pageCollabSource } : {})} {...(copyPages ? { duplicatePages: copyPages } : {})} {...(databases ? { databases } : {})} {...(ai ? { ai } : {})}
        {...(files ? { uploadFile: (f: File) => files.uploadFile(f), resolveFileUrl: (u: string) => files.resolveFileUrl(u) } : {})} />
      {client && !hideBacklinks ? <div className="shell-backlinks"><Backlinks client={client} pageID={pageID} onOpenPage={onOpenPage} /></div> : null}
    </div>
  );
}
