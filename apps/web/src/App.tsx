// BSD-153: die Shell auf echten Daten – Seitenleiste (Struktur aus dem Store-Worker), Quick Find, Seiten, Papierkorb,
// Einstellungen. Home behält vorerst die Demo-Abschnitte (src/data.ts), „Pick up again“ ist echt.
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { applyAppearance, loadAppearance, saveAppearance, type Appearance } from "./appearance.js";
import { QuickFind } from "./components/QuickFind.js";
import { Sidebar } from "./components/Sidebar.js";
import { TabBar } from "./components/TabBar.js";
import { Graph } from "./screens/Graph.js";
import { Home } from "./screens/Home.js";
import { PageView } from "./screens/PageView.js";
import { Settings } from "./screens/Settings.js";
import { Trash } from "./screens/Trash.js";
import { installNewTabIntent, wantsNewTab } from "./shell/newTabIntent.js";
import type { History, Route } from "./shell/router.js";
import { recentPages, type RecentEntry } from "./shell/storage.js";
import type { StoreClient } from "./worker/client.js";

const BOLD_FONTS = "https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600;700;800&family=Literata:opsz,wght@7..72,400;7..72,500&display=swap";

/** Bold-Schriften nur laden, wenn der Stil sie braucht. */
function ensureBoldFonts() {
  if (document.getElementById("based-bold-fonts")) return;
  const link = document.createElement("link");
  link.id = "based-bold-fonts";
  link.rel = "stylesheet";
  link.href = BOLD_FONTS;
  document.head.appendChild(link);
}

export function App({ client, history }: { client: StoreClient; history: History }) {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const route = useSyncExternalStore(history.subscribe, () => history.route);
  const [quickFind, setQuickFind] = useState(false);
  const [recent, setRecent] = useState<RecentEntry[]>(recentPages.get);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
    if (appearance.style === "bold") ensureBoldFonts();
  }, [appearance]);

  useEffect(() => recentPages.subscribe(setRecent), []);
  useEffect(() => {
    if (route.name === "page") recentPages.touch(route.id);
  }, [route]);

  // ⌘-Klick / Mittelklick: in einem neuen Tab im Hintergrund (shell/newTabIntent.ts)
  const navigate = useCallback((r: Route) => (wantsNewTab() ? void history.openTab(r, { background: true }) : history.navigate(r)), [history]);
  const openPage = useCallback((id: string) => navigate({ name: "page", id }), [navigate]);
  useEffect(() => installNewTabIntent(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey; // ⌘ auf Apple, Strg sonst
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQuickFind((v) => !v);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        history.navigate({ name: "settings" });
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "t") {
        // ⌘T/⌘W: im normalen Browser-Tab behält der Browser sie meist für sich; in der App (Tauri, PWA) und in Tests
        // kommen sie an. Sonst: + in der Tab-Leiste, ⌘-Klick, Mittelklick.
        e.preventDefault();
        history.openTab();
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w" && history.tabs.length > 1) {
        e.preventDefault();
        history.close();
      } else if (mod && e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault();
        history.cycle(e.code === "BracketRight" ? 1 : -1);
      } else if (mod && e.key === "[") {
        e.preventDefault();
        history.back();
      } else if (mod && e.key === "]") {
        e.preventDefault();
        history.forward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history]);

  const newPage = useCallback(async (opts: { parent?: string; section?: string } = {}) => {
    const id = await client.command<string | undefined>({ op: "createPage", ...opts });
    if (id) openPage(id);
    return id;
  }, [client, openPage]);

  const newDatabase = useCallback(async () => {
    const id = await client.command<string | undefined>({ op: "createDatabase", title: "Untitled database" });
    if (id) openPage(id);
  }, [client, openPage]);

  let screen;
  if (state.error) {
    screen = (
      <div className="content"><div className="column">
        <h1 className="t-title">Based couldn't open your workspace</h1>
        <p className="t-desc">{state.error}</p>
      </div></div>
    );
  } else if (route.name === "page") {
    screen = <PageView key={route.id} client={client} state={state} pageID={route.id} history={history} onOpenPage={openPage} onNavigate={navigate} />;
  } else if (route.name === "trash") {
    screen = <Trash client={client} state={state} onOpenPage={openPage} />;
  } else if (route.name === "graph") {
    screen = <Graph />;
  } else if (route.name === "settings") {
    screen = <Settings value={appearance} onChange={setAppearance} client={client} status={state.status} />;
  } else {
    screen = <Home showDetails={appearance.agentDetails} recent={recent} state={state} onOpenPage={openPage} onNewPage={() => void newPage()} onNewDatabase={() => void newDatabase()} />;
  }

  return (
    <div className="shell" data-testid="based-root" data-ready={state.ready ? "" : undefined}>
      <Sidebar client={client} state={state} route={route} onNavigate={navigate} onOpenPage={openPage} onNewPage={newPage} onQuickFind={() => setQuickFind(true)} />
      <main className="main">
        <TabBar history={history} titles={state.titles} />
        <div className="panel">{screen}</div>
      </main>
      {quickFind ? <QuickFind client={client} titles={state.titles} recent={recent} onOpen={(id) => { setQuickFind(false); openPage(id); }} onClose={() => setQuickFind(false)} /> : null}
    </div>
  );
}
