// Phase 2: @based/editor in den PageEditor-Steckplatz der Shell. Theme folgt dem Wurzel-Attribut data-theme;
// Inline-Datenbanken rendert der DatabaseView-Steckplatz (sobald @based/database-ui eingesteckt ist), Gleichungen
// KaTeX offline (BSD-10, src/equation.tsx). Erwähnungen, Seitensuche und Backlinks kommen aus dem Store-Worker
// (shell/pageDirectory.ts); Synced Blocks von anderen Seiten holt `loadSynced` in die Seiten-Replik.
import { aiSetting } from "./shell/ai.js";
import { routeToHash } from "./shell/router.js";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { BlockEditor, textDocName, type BoardEmbed, type DatabaseRenderProps, type EquationRenderProps } from "@based/editor";
import { migrateEditorPref } from "./shell/storage.js";
import { assets } from "./assetBridge.js";
import { EmbeddedBoard } from "./components/Embedded.js";
import "./assets.css";
import { Backlinks } from "./components/Backlinks.js";
import { Equation, loadTeX, renderTeX, texReady } from "./equation.js";
import { createMeetingHost, type WebMeetingHost } from "./meeting/host.js";
import { featureVisible, hiddenBlockTypes } from "./shell/beta.js";

const HIDDEN_BLOCKS = hiddenBlockTypes();
import { chatController } from "./chat/runtime.js";
import { editorAI } from "./editorAI.js";
import { linkPreviewFetcher } from "./linkPreview.js";
import { ShellPageDirectory } from "./shell/pageDirectory.js";
import { slots, type PageEditorProps } from "./slots.js";
import type { StoreClient } from "./worker/client.js";
import { WorkerYDocStore } from "./worker/ydocStore.js";
import { createCollab, pageCollab, prefixedDocStore } from "./collab.js";
import { syncConfig } from "./shell/storage.js";
import type { CollabBinder } from "@based/editor";

let shellClient: StoreClient | undefined;
let directory: ShellPageDirectory | undefined;
let meeting: WebMeetingHost | undefined;

/** BSD-281: die Aufnahme-Pille in der Seitenleiste liest den Zustand der laufenden Aufnahme. */
export const meetingHost = (): WebMeetingHost | undefined => meeting;
/** BSD-225 Teil 2: Store-Client für Datenbank-Autofill (gleiches Modell wie „Ask AI“ im Editor). */
export const editorClient = (): StoreClient | undefined => shellClient;
let docStore: WorkerYDocStore | undefined;
/** ADR 0016 (E7): Echtzeit-Text des neuen Editors (Dokumente `text:<seite>`, ein Y.Text je Block). */
let textCollab: CollabBinder | undefined;

/** Der Editor-Steckplatz braucht den Store-Client (Seitensuche, Backlinks). Einmal beim Start setzen (main.tsx). */
export function connectEditor(client: StoreClient) {
  // BSD-407: Block-Editor für alle; die alten Schalter „New editor“/„Old editor“ werden einmalig entfernt.
  migrateEditorPref();
  shellClient = client;
  directory = new ShellPageDirectory(client);
  // Beta-Gate: ohne Host lassen sich vorhandene Meeting-Blöcke lesen, aber nicht aufnehmen (BSD-453).
  meeting = featureVisible("meetings") ? createMeetingHost(client) : undefined;
  docStore = new WorkerYDocStore(client);
  // BSD-252: Seiten mit noch nicht gepushten Änderungen erst nach dem Push mit /collab öffnen (kein Verlust).
  textCollab = createCollab(prefixedDocStore(docStore, "text:"), () => syncConfig.get(), (rootID) => client.pendingLocal(rootID), textDocName);
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

// BSD-101: Link auf einen Block dieser Seite (öffnet die Seite und springt hin)
const renderEquation = (p: EquationRenderProps) => <Equation expression={p.expression} displayMode={p.displayMode} />;
// BSD-407: Inline-Gleichungen im neuen Editor als KaTeX-HTML (KaTeX lädt erst bei der ersten Gleichung)
const renderEquationHTML = (tex: string, onReady: () => void): string | undefined => {
  if (!texReady()) { void loadTeX().then(onReady, () => undefined); return undefined; }
  const r = renderTeX(tex, false);
  return "html" in r ? r.html : undefined;
};

const blockLink = (pageID: string) => (blockID: string) => {
  const u = new URL(location.href);
  u.hash = routeToHash({ name: "page", id: pageID, block: blockID });
  return u.toString();
};

export function ShellPageEditor({ store, pageID, readOnly, onOpenPage, focusBlock, embedded }: PageEditorProps) {
  const theme = useRootTheme();
  const client = shellClient;
  // BSD-407 Teil 4: nur noch der Block-Editor (ADR 0016); der alte BlockNote-Editor ist entfernt.
  const Editor = BlockEditor;
  // Feste Funktionen, solange sich nichts ändert, wovon sie abhängen: Der Editor vergleicht seine props Wert für Wert
  // und zeichnet seine Blöcke nur dann alle neu, wenn sich einer ändert. Neue Funktionen bei jedem Zeichnen hießen:
  // jede Taste zeichnet jeden Block der Seite neu (gemessen 18.11., siehe `useCtx` im Editor).
  const renderDatabase = useCallback((p: DatabaseRenderProps) => {
    const View = slots.DatabaseView;
    return View ? <View store={store} blockID={p.blockID} databaseID={p.databaseID} readOnly={readOnly} onOpenPage={onOpenPage} /> : null;
  }, [store, readOnly, onOpenPage]);
  // Elija 17.11.: ein Board als Unterseite erscheint mitten in der Seite als Fläche.
  const renderBoard = useMemo(() => (client ? (p: { pageID: string; embed?: BoardEmbed }) => <EmbeddedBoard client={client} pageID={p.pageID} onOpenPage={onOpenPage} embed={p.embed} /> : undefined), [client, onOpenPage]);
  const files = assets();
  const uploadFile = useMemo(() => (files ? (f: File) => files.uploadFile(f) : undefined), [files]);
  const resolveFileUrl = useMemo(() => (files ? (u: string) => files.resolveFileUrl(u) : undefined), [files]);
  const linkToBlock = useMemo(() => blockLink(pageID), [pageID]);
  const loadSynced = useMemo(() => (client ? (source: string) => client.includeSynced(pageID, source) : undefined), [client, pageID]);
  const databases = useMemo(() => (client ? {
    list: async (q: string) => (await client.listDatabases(q)).map((d) => ({ id: d.id, title: d.title, path: d.path })),
    include: (id: string) => client.includeDatabase(pageID, id),
  } : undefined), [client, pageID]);
  // BSD-220: Echtzeit-Text nur, wenn eingeschaltet (beim Öffnen der Seite entschieden).
  const collabOn = syncConfig.get()?.collab === true;
  // ADR 0016 (E7): der Block-Editor hat sein eigenes Dokument je Seite (Synced Blocks laufen dort über Records).
  const pageCollabSource = useMemo(() => (textCollab && collabOn ? pageCollab(textCollab, pageID, () => false) : undefined), [pageID, collabOn]);
  // BSD-225: „Ask AI“ über die Chat-Engine (Modell aus Einstellungen → Agents & AI; in Tests die Skript-Engine).
  // AI-Schalter (shell/ai.ts): ohne AI kein „Ask AI“ (Slash, Leertaste, Formatleiste).
  const aiOn = useSyncExternalStore(aiSetting.subscribe, aiSetting.get);
  const ai = useMemo(() => (client && aiOn ? editorAI((system, prompt, signal) => chatController(client).write(system, prompt, signal), () => chatController(client).canWrite()) : undefined), [client, aiOn]);
  const copyPages = useMemo(() => (client ? (ids: string[]) => client.command({ op: "duplicate", ids }) : undefined), [client]);
  const hideBacklinks = store.blocks.get(pageID)?.props?.format?.hideBacklinks === true;
  const fetchLinkPreview = useMemo(() => linkPreviewFetcher(), []);
  return (
    <div className="shell-editor">
      <Editor store={store} pageID={pageID} editable={!readOnly} onOpenPage={onOpenPage} blockLink={linkToBlock} focusBlock={focusBlock} theme={theme} renderDatabase={renderDatabase} {...(renderBoard ? { renderBoard } : {})} renderEquation={renderEquation} renderEquationHTML={renderEquationHTML}
        {...(directory ? { pages: directory } : {})} {...(loadSynced ? { loadSynced } : {})} {...(meeting ? { meeting } : {})} {...(HIDDEN_BLOCKS.size ? { hiddenBlocks: HIDDEN_BLOCKS } : {})} {...(pageCollabSource ? { collab: pageCollabSource } : {})} {...(copyPages ? { duplicatePages: copyPages } : {})} {...(databases ? { databases } : {})} {...(ai ? { ai } : {})} {...(fetchLinkPreview ? { fetchLinkPreview } : {})}
        {...(uploadFile && resolveFileUrl ? { uploadFile, resolveFileUrl } : {})} />
      {client && !hideBacklinks && !embedded ? <div className="shell-backlinks"><Backlinks client={client} pageID={pageID} onOpenPage={onOpenPage} /></div> : null}
    </div>
  );
}
