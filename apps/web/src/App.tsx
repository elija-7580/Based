// BSD-153: die Shell auf echten Daten – Seitenleiste (Struktur aus dem Store-Worker), Quick Find, Seiten, Papierkorb,
// Einstellungen. Home ist die Startseite nach Mockup v10 (Zeitbogen, Auftragskarten; BSD-162/197) mit Agent- und
// Projekt-Detail (BSD-133).
import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { appearanceStore, applyAppearance, effectiveTheme, onSystemThemeChange } from "./appearance.js";
import { ChatDock, ChatPage } from "./chat/ChatDock.js";
import { ImportDialog } from "./components/ImportExport.js";
import { hybridImport } from "./worker/notionHybridClient.js";
import { NewPalette, type PaletteCommand } from "./components/NewPalette.js";
import { QuickFind } from "./components/QuickFind.js";
import { DevOverlay } from "./components/DevOverlay.js";
import { ReportProblemDialog } from "./components/ReportProblem.js";
import { REPORT_PROBLEM_EVENT } from "./desktop.js";
import { startReport } from "./shell/reportUI.js";
import { Sidebar } from "./components/Sidebar.js";
import { Notice } from "./components/Notice.js";
import { PromptHost } from "./components/PromptHost.js";
import { registerContextItems } from "@based/ui/native";
import { shortcutLabel } from "@based/ui";
import { TabBar } from "./components/TabBar.js";
import { Home } from "./screens/Home.js";
import { PageView } from "./screens/PageView.js";
import { tasksRuntime } from "./tasks/runtime.js";
import "./tasks/AgentSettingsSection.js";
import { installHistoryGestures } from "./shell/historyGestures.js";
import { installKeyHints } from "./shell/keyHints.js";
import { Icon } from "./icons.js";
import { installNewTabIntent, wantsNewTab } from "./shell/newTabIntent.js";
import { cycleRegion } from "./shell/regions.js";
import { FIND_EVENT, matchShortcut, parentPage } from "./shell/shortcuts.js";
import type { History, Route } from "./shell/router.js";
import { homeTarget, newPageFormat, recentPages, spellCheckPref, startPage, type RecentEntry } from "./shell/storage.js";
import type { StoreClient } from "./worker/client.js";

// BSD-280: selten gebrauchte Ansichten erst beim Öffnen laden (kleineres Start-Bundle, schnellerer Start).
const AgentDetailScreen = lazy(() => import("./home/AgentDetail.js").then((m) => ({ default: m.AgentDetailScreen })));
const ProjectDetailScreen = lazy(() => import("./home/ProjectDetail.js").then((m) => ({ default: m.ProjectDetailScreen })));
const Meetings = lazy(() => import("./screens/Meetings.js").then((m) => ({ default: m.Meetings })));
const Graph = lazy(() => import("./screens/Graph.js").then((m) => ({ default: m.Graph })));
const Library = lazy(() => import("./screens/Library.js").then((m) => ({ default: m.Library })));
const Settings = lazy(() => import("./screens/Settings.js").then((m) => ({ default: m.Settings })));
const Trash = lazy(() => import("./screens/Trash.js").then((m) => ({ default: m.Trash })));
const TasksScreen = lazy(() => import("./tasks/TasksScreen.js").then((m) => ({ default: m.TasksScreen })));
const CodingScreen = lazy(() => import("./coding/CodingScreen.js").then((m) => ({ default: m.CodingScreen })));

/** Bold-Schriften nur laden, wenn der Stil sie braucht – lokal gebündelt (boldFonts.ts), nicht von fremden Servern. */
function ensureBoldFonts() {
  void import("./boldFonts.js").catch(() => undefined);
}

export function App({ client, history }: { client: StoreClient; history: History }) {
  const appearance = useSyncExternalStore(appearanceStore.subscribe, appearanceStore.get);
  const setAppearance = appearanceStore.set;
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const route = useSyncExternalStore(history.subscribe, () => history.route);
  const [quickFind, setQuickFind] = useState(false);
  const [recent, setRecent] = useState<RecentEntry[]>(recentPages.get);

  useEffect(() => {
    applyAppearance(appearance);
    if (appearance.style === "bold") ensureBoldFonts();
    return appearance.theme === "system" ? onSystemThemeChange(() => applyAppearance(appearance)) : undefined;
  }, [appearance]);

  useEffect(() => recentPages.subscribe(setRecent), []);
  // Hauptagent: offene Aufträge fortsetzen, Unteragenten und Zeitpläne (solange die App offen ist)
  useEffect(() => {
    if (state.ready) tasksRuntime(client).start();
  }, [state.ready, client]);
  useEffect(() => {
    if (route.name === "page") recentPages.touch(route.id);
  }, [route]);

  // ⌘-Klick / Mittelklick: in einem neuen Tab im Hintergrund (shell/newTabIntent.ts)
  const navigate = useCallback((r: Route) => (wantsNewTab() ? void history.openTab(r, { background: true }) : history.navigate(r)), [history]);
  const openPage = useCallback((id: string) => navigate({ name: "page", id }), [navigate]);
  // Home kann eine Seite sein (Einstellungen → My settings → Home, oder Rechtsklick → „Set as Home“); sonst das Dashboard.
  const homeChoice = useSyncExternalStore(startPage.subscribe, startPage.get);
  const homePage = (() => {
    const t = homeTarget(homeChoice, state.outline ? { has: (id) => Boolean(state.outline!.nodes[id]) && !state.outline!.trash.some((x) => x.id === id) } : undefined);
    return t.name === "page" ? t.id : undefined;
  })();
  const goHome = useCallback(() => navigate(homePage ? { name: "page", id: homePage } : { name: "home" }), [navigate, homePage]);
  useEffect(() => installNewTabIntent(), []);
  // BSD-168: Rechtschreibprüfung (Einstellungen → My settings); contenteditable erbt `spellcheck` vom body.
  const spellCheck = useSyncExternalStore(spellCheckPref.subscribe, spellCheckPref.get);
  useEffect(() => { document.body.spellcheck = spellCheck; }, [spellCheck]);
  // BSD-244: Maustasten 4/5, ⌘←/⌘→ und Wischen; der Hinweis am Rand folgt dem Finger ohne React-Render.
  const swipeHint = useRef<HTMLDivElement>(null);
  // BSD-270: ⌘ (Strg) lange halten blendet die Kürzel-Plaketten ein
  useEffect(() => installKeyHints(window), []);
  useEffect(() => installHistoryGestures(window, history, (p) => {
    const el = swipeHint.current;
    if (!el) return;
    el.style.setProperty("--swipe", String(Math.abs(p)));
    el.dataset.side = p > 0 ? "back" : p < 0 ? "forward" : "";
  }), [history]);


  const newPage = useCallback(async (opts: { parent?: string; section?: string } = {}) => {
    const id = await client.command<string | undefined>({ op: "createPage", ...opts, format: newPageFormat.get() });
    if (id) openPage(id);
    return id;
  }, [client, openPage]);

  const newDatabase = useCallback(async () => {
    const id = await client.command<string | undefined>({ op: "createDatabase", title: "Untitled database" });
    if (id) openPage(id);
  }, [client, openPage]);

  const newMeeting = useCallback(async () => {
    const id = await client.command<string | undefined>({ op: "createMeetingPage" });
    if (id) openPage(id);
  }, [client, openPage]);

  const outlineRef = useRef(state.outline);
  outlineRef.current = state.outline;
  // Rechtsklick auf freie Flächen: die wichtigsten Wege der App (in Textfeldern stehen dort nur die Text-Einträge).
  useEffect(() => registerContextItems((info) => {
    if (info.editable || info.selection) return [];
    const mod = shortcutLabel;
    const apple = /Mac|iPhone|iPad/.test(navigator.platform);
    return [
      { label: "Search…", icon: "search", hint: mod("K", { apple }), run: () => setQuickFind(true) },
      { label: "New page", icon: "page", hint: apple ? "⌥⌘N" : "Ctrl+Alt+N", run: () => void newPage() },
      { separator: true },
      { label: "Back", icon: "back", hint: mod("[", { apple }), run: () => history.back() },
      { label: "Forward", icon: "forward", hint: mod("]", { apple }), run: () => history.forward() },
      { separator: true },
      { label: "Settings", icon: "settings", hint: mod(",", { apple }), run: () => history.navigate({ name: "settings" }) },
    ];
  }), [history, newPage]);
  // BSD-204: Kürzel (shell/shortcuts.ts) und Befehlspalette „New…“ (⌘N).
  const [palette, setPalette] = useState(false);
  const [importing, setImporting] = useState<false | "pick" | "notion">(false);
  // BSD-317: unfertigen Notion-Import nach dem Start anbieten (Seitenleiste zeigt „Import paused“).
  useEffect(() => { if (state.ready) void hybridImport.restore(client); }, [client, state.ready]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F6" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // BSD-238: Bereiche per Tastatur (Seitenleiste → Kopfzeile → Seite).
        if (cycleRegion(document, e.shiftKey ? -1 : 1)) e.preventDefault();
        return;
      }
      const a = matchShortcut(e);
      if (!a) return;
      if (a.kind === "find" || a.kind === "findStep") {
        // BSD-206: nur auf Seiten; die Seite hört selbst zu (PageView). Sonst bleibt ⌘F beim Browser.
        if (history.route.name !== "page") return;
        const ev = new CustomEvent(FIND_EVENT, { detail: a, cancelable: true });
        if (!window.dispatchEvent(ev)) e.preventDefault();
        return;
      }
      e.preventDefault();
      switch (a.kind) {
        // Sofort zeichnen, damit das Suchfeld den Fokus hat, bevor die nächste Taste kommt (schnelles Tippen nach ⌘K).
        case "quickFind": flushSync(() => { setPalette(false); setQuickFind((v) => !v); }); break;
        case "palette": setQuickFind(false); setPalette((v) => !v); break;
        case "newPage": void newPage(); break;
        case "settings": history.navigate({ name: "settings" }); break;
        case "toggleTheme": {
          const cur = appearanceStore.get();
          setAppearance({ ...cur, theme: effectiveTheme(cur) === "dark" ? "light" : "dark" });
          break;
        }
        // ⌘T/⌘W: auch der letzte Tab – dann öffnet die Startseite, die App bleibt offen.
        case "newTab": history.openTab(); break;
        case "closeTab": history.close(); break;
        case "cycleTab": history.cycle(a.delta); break;
        case "tab": {
          const tabs = history.tabs;
          const t = a.index < 0 ? tabs[tabs.length - 1] : tabs[a.index];
          if (t) history.activate(t.id);
          break;
        }
        case "back": history.back(); break;
        case "forward": history.forward(); break;
        case "reportProblem": void startReport(); break;
        case "openParent": {
          const r = history.route;
          if (r.name !== "page") break;
          const parent = parentPage(outlineRef.current, r.id);
          if (parent) navigate({ name: "page", id: parent });
          // Datenbank-Zeilen stehen nicht in der Seitenleisten-Struktur: der Worker kennt ihre Datenbankseite.
          else void client.command<string[]>({ op: "pageAncestors", id: r.id }).then((up) => { const p = up.at(-1); if (p) navigate({ name: "page", id: p }); });
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    // BSD-319: Mac-App, Menü Hilfe → „Report a Problem…“ (⇧⌘B liegt dort als Menükürzel)
    const onReport = () => void startReport();
    window.addEventListener(REPORT_PROBLEM_EVENT, onReport);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(REPORT_PROBLEM_EVENT, onReport);
    };
  }, [history, newPage, setAppearance, navigate, client]);

  // BSD-256: feste Reihenfolge, Ziffern 1–9 wählen direkt (1 Page, 2 AI chat, 3 Meeting notes, 4 Database).
  const commands: PaletteCommand[] = [
    { id: "page", title: "New page", hint: "⌥⌘N", icon: "page", keywords: "document note", run: () => void newPage() },
    { id: "chat", title: "New AI chat", hint: "⌘J", icon: "chat", keywords: "ai agent ask", run: () => history.navigate({ name: "chat" }) },
    { id: "meeting", title: "New meeting notes", icon: "mic", keywords: "meeting record transcribe notes", run: () => void newMeeting() },
    { id: "database", title: "New database", icon: "database", keywords: "table board", run: () => void newDatabase() },
    { id: "import", title: "Import…", icon: "library", keywords: "markdown notion html csv", run: () => setImporting("pick") },
  ];

  let screen;
  if (state.error) {
    screen = (
      <div className="content"><div className="column">
        <h1 className="t-title">Based couldn't open your workspace</h1>
        <p className="t-desc">{state.error}</p>
      </div></div>
    );
  } else if (route.name === "page") {
    screen = <PageView key={route.id} client={client} state={state} pageID={route.id} history={history} onOpenPage={openPage} onNavigate={navigate} focusBlock={route.block} />;
  } else if (route.name === "trash") {
    screen = <Trash client={client} state={state} onOpenPage={openPage} />;
  } else if (route.name === "chat") {
    screen = <ChatPage client={client} history={history} />;
  } else if (route.name === "tasks") {
    screen = <TasksScreen client={client} state={state} />;
  } else if (route.name === "coding") {
    screen = <CodingScreen />;
  } else if (route.name === "agent") {
    screen = <AgentDetailScreen key={route.id} client={client} state={state} runID={route.id} onNavigate={navigate} onOpenPage={openPage} />;
  } else if (route.name === "project") {
    screen = <ProjectDetailScreen key={route.id} client={client} state={state} projectID={route.id} showDetails={appearance.agentDetails} onNavigate={navigate} onOpenPage={openPage} />;
  } else if (route.name === "library") {
    screen = <Library client={client} state={state} onOpenPage={openPage} onSwitch={(to) => navigate({ name: to })} />;
  } else if (route.name === "graph") {
    screen = <Graph client={client} state={state} onOpenPage={openPage} onSwitch={(to) => navigate({ name: to })} />;
  } else if (route.name === "meetings") {
    screen = <Meetings client={client} state={state} onOpenPage={openPage} onSwitch={(to) => navigate({ name: to })} onNewMeeting={() => void newMeeting()} />;
  } else if (route.name === "settings") {
    screen = <Settings page={route.page} value={appearance} onChange={setAppearance} client={client} state={state} onNavigate={navigate} />;
  } else {
    screen = <Home client={client} showDetails={appearance.agentDetails} state={state} onOpenPage={openPage} onNavigate={navigate} onNewPage={() => void newPage()} onNewDatabase={() => void newDatabase()} />;
  }

  return (
    <div className="shell" data-testid="based-root" data-ready={state.ready ? "" : undefined}>
      <Sidebar client={client} state={state} route={route} homePage={homePage} onHome={goHome} onNavigate={navigate} onOpenPage={openPage} onNewPage={newPage} onQuickFind={() => setQuickFind(true)} onImportStatus={() => setImporting("notion")} advanced={appearance.agentDetails} />
      <main className="main">
        <TabBar history={history} titles={state.titles} />
        <div className="panel"><Suspense fallback={<div className="screen-loading" role="status" aria-label="Loading" />}>{screen}</Suspense></div>
        <div ref={swipeHint} className="swipe-hint" aria-hidden="true" data-side="">
          <span className="swipe-back"><Icon name="back" size={18} /></span>
          <span className="swipe-forward"><Icon name="forward" size={18} /></span>
        </div>
      </main>
      <ChatDock client={client} history={history} route={route} />
      <Notice notice={state.notice} onDismiss={client.dismissNotice} />
      <PromptHost />
      {palette ? <NewPalette commands={commands} onClose={() => setPalette(false)} /> : null}
      <DevOverlay />
      <ReportProblemDialog onOpenDiagnostics={() => history.navigate({ name: "settings", page: "diagnostics" })} />
      {importing ? <ImportDialog client={client} initial={importing} onClose={() => setImporting(false)} onOpenPage={openPage} /> : null}
      {quickFind ? <QuickFind client={client} titles={state.titles} recent={recent} currentPage={route.name === "page" ? { id: route.id, title: state.titles.get(route.id) || "Untitled" } : undefined} onOpen={(id) => { setQuickFind(false); openPage(id); }} onClose={() => setQuickFind(false)}
        onCommand={(id) => {
          setQuickFind(false);
          if (id === "meeting") void newMeeting();
          else if (id === "home") goHome();
          else if (id === "dashboard") navigate({ name: "home" });
          else if (id === "report") void startReport();
          else if (id === "chat" || id === "tasks" || id === "coding" || id === "graph" || id === "meetings" || id === "library" || id === "trash" || id === "settings") navigate({ name: id });
        }} /> : null}
    </div>
  );
}
