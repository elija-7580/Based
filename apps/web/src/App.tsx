// BSD-153: die Shell auf echten Daten – Seitenleiste (Struktur aus dem Store-Worker), Quick Find, Seiten, Papierkorb,
// Einstellungen. Home ist die Startseite nach Mockup v10 (Zeitbogen, Auftragskarten; BSD-162/197) mit Agent- und
// Projekt-Detail (BSD-133).
import { lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { appearanceStore, applyAppearance, effectiveTheme, onSystemThemeChange, type AppFont } from "./appearance.js";
import { basedFontsReady, loadBasedFonts } from "./fonts.js";
import { ImportDialog } from "./components/ImportExport.js";
import { hybridImport } from "./worker/notionHybridClient.js";
import { NewPalette, type PaletteCommand } from "./components/NewPalette.js";
import { QuickFind } from "./components/QuickFind.js";
import { pagePick } from "./shell/pagePick.js";
import { DevOverlay } from "./components/DevOverlay.js";
import { ReportProblemDialog } from "./components/ReportProblem.js";
import { TrashUndo } from "./components/TrashUndo.js";
import { ShortcutHud } from "./components/ShortcutHud.js";
import { ShortcutSheet } from "./components/ShortcutSheet.js";
import { installArrowNav } from "./shell/arrowNav.js";
import { COMMAND_EVENT, installCommands } from "./shell/commands.js";
import { bringToFront, isPageWindow, isTauri, REPORT_PROBLEM_EVENT } from "./desktop.js";
import { meetingHost } from "./editorSlot.js";
import { startMeetingDetection } from "./meeting/detect.js";
import { startReport } from "./shell/reportUI.js";
import { Sidebar } from "./components/Sidebar.js";
import { Notice } from "./components/Notice.js";
import { PromptHost } from "./components/PromptHost.js";
import { registerContextItems } from "@based/ui/native";
import { shortcutLabel } from "@based/ui";
import { TabBar } from "./components/TabBar.js";
import { PageView } from "./screens/PageView.js";
import { HomePlain } from "./screens/HomePlain.js";
import { loadChatRuntime } from "./chat/load.js";
import { installHistoryGestures } from "./shell/historyGestures.js";
import { installKeyHints } from "./shell/keyHints.js";
import { Icon, type IconName } from "./icons.js";
import { STARTER_TEMPLATES, type StarterTemplateID } from "@based/core";
import { installNewTabIntent, wantsNewTab } from "./shell/newTabIntent.js";
import { cycleRegion, toggleSidebarFocus } from "./shell/regions.js";
import { FIND_EVENT, matchShortcut, menuOwnsShortcut, parentPage } from "./shell/shortcuts.js";
import type { History, Route } from "./shell/router.js";
import { firstRun, welcomeTour } from "./shell/firstRun.js";
import { aiSetting } from "./shell/ai.js";
import { commandVisible } from "./shell/beta.js";
import { beginFreshPage, cancelFreshPage, markFreshPage } from "./shell/freshPage.js";
import { hiddenRoute } from "./shell/hiddenRoute.js";
import { fallbackHomePage, homeStaysEmpty, homeTarget, meetingDetectPref, newPageFormat, recentPages, spellCheckPref, startPage, type RecentEntry } from "./shell/storage.js";
import type { StoreClient } from "./worker/client.js";

// BSD-280: selten gebrauchte Ansichten erst beim Öffnen laden (kleineres Start-Bundle, schnellerer Start).
// BSD-595: Chat, Agenten-Home und Hauptagent sind eigene Chunks – geladen erst, wenn AI an ist (auf der Beta nie).
const ChatDock = lazy(() => import("./chat/ChatDock.js").then((m) => ({ default: m.ChatDock })));
const ChatPage = lazy(() => import("./chat/ChatDock.js").then((m) => ({ default: m.ChatPage })));
const Home = lazy(() => import("./screens/Home.js").then((m) => ({ default: m.Home })));
const AgentDetailScreen = lazy(() => import("./home/AgentDetail.js").then((m) => ({ default: m.AgentDetailScreen })));
const ProjectDetailScreen = lazy(() => import("./home/ProjectDetail.js").then((m) => ({ default: m.ProjectDetailScreen })));
const Meetings = lazy(() => import("./screens/Meetings.js").then((m) => ({ default: m.Meetings })));
const Graph = lazy(() => import("./screens/Graph.js").then((m) => ({ default: m.Graph })));
const Library = lazy(() => import("./screens/Library.js").then((m) => ({ default: m.Library })));
const Settings = lazy(() => import("./screens/Settings.js").then((m) => ({ default: m.Settings })));
const Trash = lazy(() => import("./screens/Trash.js").then((m) => ({ default: m.Trash })));
const TasksScreen = lazy(() => import("./tasks/TasksScreen.js").then((m) => ({ default: m.TasksScreen })));
// BSD-275: Willkommensbildschirm nur beim ersten Start
const Welcome = lazy(() => import("./screens/Welcome.js").then((m) => ({ default: m.Welcome })));
const WelcomeTourScreen = lazy(() => import("./screens/WelcomeTour.js").then((m) => ({ default: m.WelcomeTourScreen })));
const CodingScreen = lazy(() => import("./coding/CodingScreen.js").then((m) => ({ default: m.CodingScreen })));


/** Schrift, die gerade am Wurzelelement steht (bis Font „Based“ geladen ist, bleibt sie stehen). */
const shownFont = (): AppFont => (document.documentElement.dataset.typeface === "based" ? "based" : "system");

/** Ziel nimmt Text auf (Eingabefeld, Textbereich, bearbeitbarer Inhalt)? Dann gehört ⌫ dem Feld. */
function isTextTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return !t.readOnly;
  if (t instanceof HTMLInputElement) return !t.readOnly && !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(t.type);
  return false;
}

export function App({ client, history }: { client: StoreClient; history: History }) {
  const appearance = useSyncExternalStore(appearanceStore.subscribe, appearanceStore.get);
  const setAppearance = appearanceStore.set;
  const state = useSyncExternalStore(client.subscribe, client.getState);
  const route = useSyncExternalStore(history.subscribe, () => history.route);
  const [quickFind, setQuickFind] = useState(false);
  // Seite wählen wie mit ⌘K (Board: Seite aufs Board legen) – dieselbe Suche, die gewählte Seite geht an den Fragenden.
  const pick = useSyncExternalStore(pagePick.subscribe, pagePick.get);
  const [recent, setRecent] = useState<RecentEntry[]>(recentPages.get);
  const welcome = useSyncExternalStore(firstRun.subscribe, firstRun.get);
  // BSD-551: Einstieg erneut (Hilfe → Show Welcome Tour, ⌘K); schließt, sobald man woandershin geht.
  const tourOpen = useSyncExternalStore(welcomeTour.subscribe, welcomeTour.get);

  useEffect(() => {
    // Font „Based“ erst setzen, wenn die Dateien da sind – sonst zeigt die Oberfläche kurz die Ersatzschrift und
    // springt dann um (fonts.ts). Bis dahin bleibt die bisherige Schrift stehen.
    let live = true;
    const apply = () => applyAppearance(appearance.font === "based" && !basedFontsReady() ? { ...appearance, font: shownFont() } : appearance);
    apply();
    if (appearance.font === "based" && !basedFontsReady()) void loadBasedFonts().then(() => { if (live) applyAppearance(appearance); });
    const off = appearance.theme === "system" ? onSystemThemeChange(apply) : undefined;
    return () => { live = false; off?.(); };
  }, [appearance]);

  useEffect(() => recentPages.subscribe(setRecent), []);
  // AI-Schalter (shell/ai.ts): ohne AI kein Chat, kein Hauptagent, keine Aufträge, kein Coding; Home ist eine Seite.
  const ai = useSyncExternalStore(aiSetting.subscribe, aiSetting.get);
  // Hauptagent: offene Aufträge fortsetzen, Unteragenten und Zeitpläne (solange die App offen ist und AI an ist)
  useEffect(() => {
    if (!state.ready || !ai) return;
    // BSD-595: Chat-Code vorab laden, damit „Ask AI“ und Autofill sofort wissen, ob ein Modell eingerichtet ist.
    void loadChatRuntime();
    let stop: (() => void) | undefined, gone = false;
    void import("./tasks/runtime.js").then(({ tasksRuntime }) => {
      if (gone) return;
      const rt = tasksRuntime(client);
      rt.start();
      stop = () => rt.stop();
    });
    return () => { gone = true; stop?.(); };
  }, [state.ready, client, ai]);
  useEffect(() => {
    if (route.name === "page") recentPages.touch(route.id);
    welcomeTour.close();
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
  // Feedback 20. 11.: Home bleibt leer (HomePlain), wenn man sie entfernt oder die Home-Seite gelöscht hat.
  const homeEmpty = homeStaysEmpty(homeChoice, { cleared: startPage.cleared(), trashedID: startPage.trashed() }, state.outline);
  useEffect(() => {
    if (homeChoice && state.outline?.trash.some((t) => t.id === homeChoice)) startPage.noteTrashed(homeChoice);
  }, [homeChoice, state.outline]);
  const goHome = useCallback(() => navigate(homePage ? { name: "page", id: homePage } : { name: "home" }), [navigate, homePage]);
  const goHomeRef = useRef(goHome);
  goHomeRef.current = goHome;
  // Ohne AI ist Home einfach eine Seite. BSD-461: fehlt eine gewählte Home-Seite, wird eine vorhandene Seite Home
  // („Welcome to Based“, sonst die erste unter Private) – keine leere Seite „Home“ mehr. Nur ein Workspace ganz ohne
  // Seiten bekommt einmal eine. Schon angelegte Home-Seiten älterer Starts bleiben, wie sie sind.
  const creatingHome = useRef(false);
  const aiRoute = route.name === "chat" || route.name === "tasks" || route.name === "coding" || route.name === "agent" || route.name === "project";
  const wantsHome = route.name === "home" || (!ai && aiRoute);
  // BSD-486: ausgeblendete Ansicht (alter Tab, Lesezeichen) → Home, und die Adresse wird #home statt stehen zu bleiben.
  const hidden = hiddenRoute(route, ai);
  useEffect(() => { if (hidden) history.navigate({ name: "home" }, { replace: true }); }, [hidden, history]);
  // Feedback 20. 11.: Nach Löschen der Home-Seite oder „Remove as Home“ bleibt Home leer (HomePlain) – keine andere
  // Seite rückt mehr nach (homeStaysEmpty).
  useEffect(() => {
    if (ai || !wantsHome || homePage || !state.ready || !state.outline || welcome || creatingHome.current || homeEmpty) return;
    const existing = fallbackHomePage(state.outline, state.titles);
    if (existing) {
      startPage.set(existing);
      return;
    }
    creatingHome.current = true;
    void client.command<string | undefined>({ op: "createPage", title: "Home" })
      .then((id) => { if (id) startPage.set(id); })
      .catch(() => undefined)
      .finally(() => { creatingHome.current = false; });
  }, [ai, wantsHome, homePage, state.ready, state.outline, state.titles, welcome, client, homeEmpty]);
  useEffect(() => installNewTabIntent(), []);
  // BSD-168: Rechtschreibprüfung (Einstellungen → My settings); contenteditable erbt `spellcheck` vom body.
  const spellCheck = useSyncExternalStore(spellCheckPref.subscribe, spellCheckPref.get);
  useEffect(() => { document.body.spellcheck = spellCheck; }, [spellCheck]);
  // BSD-244: Maustasten 4/5, ⌘←/⌘→ und Wischen; der Hinweis am Rand folgt dem Finger ohne React-Render.
  const swipeHint = useRef<HTMLDivElement>(null);
  // BSD-270: ⌘ (Strg) lange halten blendet die Kürzel-Plaketten ein
  useEffect(() => installKeyHints(window), []);
  // Tastatur überall: Pfeiltasten zwischen Bedienelementen, Seitenleiste als Liste, ⇧F10 (shell/arrowNav.ts);
  // Befehle aus dem Mac-Menü laufen über dieselben Tasten (shell/commands.ts).
  useEffect(() => installArrowNav(window), []);
  useEffect(() => {
    const commands = installCommands(window);
    // BSD-551: Hilfe → „Show Welcome Tour“ (menu.rs, ohne Taste) kommt über denselben Weg.
    const onCommand = (e: Event) => { const id = String((e as CustomEvent).detail); if (id === "welcomeTour") welcomeTour.show(); else commands.run(id); };
    window.addEventListener(COMMAND_EVENT, onCommand);
    return () => { window.removeEventListener(COMMAND_EVENT, onCommand); commands.dispose(); };
  }, []);
  const [sheet, setSheet] = useState(false);
  useEffect(() => installHistoryGestures(window, history, (p) => {
    const el = swipeHint.current;
    if (!el) return;
    el.style.setProperty("--swipe", String(Math.abs(p)));
    el.dataset.side = p > 0 ? "back" : p < 0 ? "forward" : "";
  }), [history]);


  const newPage = useCallback(async (opts: { parent?: string; section?: string } = {}) => {
    // BSD-645: was man tippt, bevor der neue Titel den Fokus hat, fängt freshPage auf und gibt es dem Titel
    const token = beginFreshPage();
    const id = await client.command<string | undefined>({ op: "createPage", ...opts, format: newPageFormat.get() }).catch((e: unknown) => {
      cancelFreshPage(token);
      throw e;
    });
    if (id) {
      markFreshPage(id, token);
      openPage(id);
    } else cancelFreshPage(token);
    return id;
  }, [client, openPage]);

  const newDatabase = useCallback(async () => {
    const token = beginFreshPage();
    const id = await client.command<string | undefined>({ op: "createDatabase", title: "Untitled database" }).catch((e: unknown) => {
      cancelFreshPage(token);
      throw e;
    });
    // BSD-617: wie eine neue Seite (BSD-482) – die Schreibmarke steht im Titel, wer gleich tippt, benennt sie.
    if (id) {
      markFreshPage(id, token);
      openPage(id);
    } else cancelFreshPage(token);
  }, [client, openPage]);

  const newFromTemplate = useCallback(async (template: StarterTemplateID) => {
    const id = await client.command<string | undefined>({ op: "addStarterTemplate", template });
    if (id) openPage(id);
  }, [client, openPage]);

  const newBoard = useCallback(async () => {
    const id = await client.command<string | undefined>({ op: "createBoard" });
    if (id) openPage(id);
  }, [client, openPage]);

  const newMeeting = useCallback(async () => {
    const id = await client.command<string | undefined>({ op: "createMeetingPage" });
    if (id) openPage(id);
  }, [client, openPage]);
  // 23. 11. (Elija: „Ideen festhalten mit Audio“): ein Befehl – neue Notiz, die Aufnahme läuft sofort.
  const newVoiceNote = useCallback(async () => {
    const id = await client.command<string | undefined>({ op: "createMeetingPage" });
    if (!id) return;
    openPage(id);
    await meetingHost()?.startOnPage(id);
  }, [client, openPage]);

  // Feedback 18. 11.: Mac-App – startet eine Meeting-App (Zoom, Teams, Meet …) das Mikrofon, fragt ein kleines Fenster
  // oben rechts, ob Based transkribieren soll. „Start transcribing“: neues Meeting, Fenster nach vorn, Aufnahme läuft.
  useEffect(() => {
    if (!isTauri() || isPageWindow() || !meetingHost()) return;
    return startMeetingDetection({
      enabled: () => meetingDetectPref.get(),
      recording: () => meetingHost()?.getState().recording === true,
      onStart: () => void (async () => {
        await bringToFront();
        const id = await client.command<string | undefined>({ op: "createMeetingPage" });
        if (!id) return;
        openPage(id);
        await meetingHost()?.startOnPage(id);
      })(),
    });
  }, [client, openPage]);

  const outlineRef = useRef(state.outline);
  outlineRef.current = state.outline;
  // Rechtsklick auf freie Flächen: die wichtigsten Wege der App (in Textfeldern stehen dort nur die Text-Einträge).
  useEffect(() => registerContextItems((info) => {
    if (info.editable || info.selection) return [];
    // Auf einem Board gilt nur das Menü des Boards (Elija 17.11.: Menüs je Seitentyp).
    if (info.target.closest(".wb-root")) return [];
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
      // WebKit (Mac-App) navigiert bei ⌫/Entf ohne Textfeld im Fokus zurück – unser Router hängt an der
      // Browser-Historie, also sprang man nach dem Löschen von Blöcken/Zeilen auf die vorige Seite.
      if ((e.key === "Backspace" || e.key === "Delete") && !isTextTarget(e.target)) { e.preventDefault(); return; }
      if (e.key === "F6" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // BSD-238: Bereiche per Tastatur (Seitenleiste → Kopfzeile → Seite).
        if (cycleRegion(document, e.shiftKey ? -1 : 1)) e.preventDefault();
        return;
      }
      const a = matchShortcut(e);
      if (!a) return;
      // BSD-310: ⌘W in der Desktop-App ans Menü durchlassen (kein preventDefault), sonst kommt „Close Tab“ nie an.
      if (menuOwnsShortcut(a, isTauri())) return;
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
        // BSD-421: ⌘, in den Einstellungen geht zurück, wo man war
        case "settings":
          if (history.route.name !== "settings") history.navigate({ name: "settings" });
          else history.leaveSettings();
          break;
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
        case "shortcuts": setQuickFind(false); setPalette(false); setSheet((v) => !v); break;
        case "home": goHomeRef.current(); break;
        case "focusSidebar":
          // Ausgeblendete Seitenleiste erst zeigen (⌘\ über denselben Weg wie die Taste), dann hinein.
          if (!toggleSidebarFocus(document)) {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", code: "Backslash", metaKey: e.metaKey, ctrlKey: e.ctrlKey, bubbles: true }));
            requestAnimationFrame(() => requestAnimationFrame(() => toggleSidebarFocus(document)));
          }
          break;
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
    ...(ai ? [{ id: "chat", title: "New AI chat", hint: "⌘J", icon: "chat", keywords: "ai agent ask", run: () => history.navigate({ name: "chat" }) } satisfies PaletteCommand] : []),
    ...(commandVisible("meeting") ? [{ id: "meeting", title: "New meeting notes", icon: "mic", keywords: "meeting record transcribe notes", run: () => void newMeeting() } satisfies PaletteCommand] : []),
    { id: "database", title: "New database", icon: "database", keywords: "table board", run: () => void newDatabase() },
    { id: "import", title: "Import…", icon: "library", keywords: "markdown notion html csv", run: () => setImporting("pick") },
    // BSD-264: Board-Seite (auf beta ausgeblendet, solange es nur die Fläche gibt); nach „Import…“, damit die Ziffern 1–5 bleiben
    ...(commandVisible("board") ? [{ id: "board", title: "New board", icon: "board", keywords: "whiteboard canvas draw sticky", run: () => void newBoard() } satisfies PaletteCommand] : []),
    ...(commandVisible("meeting") ? [{ id: "voice-note", title: "Record a voice note", icon: "mic", keywords: "audio idea memo dictate record sprachnotiz", run: () => void newVoiceNote() } satisfies PaletteCommand] : []),
    // BSD-436: Startvorlagen auch später (wie im Willkommensbildschirm), oben unter Private
    ...STARTER_TEMPLATES.map((t) => ({ id: "template-" + t.id, title: `${t.title} template`, icon: t.icon as IconName, keywords: "template starter", run: () => void newFromTemplate(t.id) }) satisfies PaletteCommand),
  ];

  let screen;
  if (state.error) {
    screen = (
      <div className="content"><div className="column">
        <h1 className="t-title">Based couldn't open your workspace</h1>
        <p className="t-desc">{state.error}</p>
      </div></div>
    );
  } else if (tourOpen) {
    screen = <WelcomeTourScreen onClose={welcomeTour.close} onNavigate={navigate} />;
  } else if (route.name === "page") {
    screen = <PageView key={route.id} client={client} state={state} pageID={route.id} history={history} onOpenPage={openPage} onNavigate={navigate} focusBlock={route.block} />;
  } else if (route.name === "trash") {
    screen = <Trash client={client} state={state} onOpenPage={openPage} />;
  } else if (!ai && wantsHome && !(welcome && state.ready && state.outline?.nodes[welcome.page] && !state.outline.trash.some((x) => x.id === welcome.page))) {
    // Ohne AI: Home zeigt die Home-Seite (oder lädt, bis sie angelegt ist); AI-Routen (alte Tabs, Links) landen hier.
    screen = homePage
      ? <PageView key={homePage} client={client} state={state} pageID={homePage} history={history} onOpenPage={openPage} onNavigate={navigate} />
      : state.ready && homeEmpty
        ? <HomePlain state={state} onNewPage={() => void newPage()} onQuickFind={() => setQuickFind(true)} />
        : <div className="screen-loading" role="status" aria-label="Loading" />;
  } else if (hidden) {
    // Beta-Gate (BSD-486): ausgeblendete Ansicht – der Effekt oben schreibt gleich auf #home um.
    screen = <div className="screen-loading" role="status" aria-label="Loading" />;
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
    screen = <Settings page={route.page} value={appearance} onChange={setAppearance} client={client} state={state} onNavigate={navigate} onClose={() => history.leaveSettings()} />;
  } else if (welcome && state.ready && state.outline?.nodes[welcome.page] && !state.outline.trash.some((x) => x.id === welcome.page)) {
    screen = <Welcome client={client} pending={welcome} onOpenPage={openPage} onNavigate={navigate} onImport={() => setImporting("pick")} />;
  } else {
    screen = <Home client={client} showDetails={appearance.agentDetails} state={state} onOpenPage={openPage} onNavigate={navigate} onNewPage={() => void newPage()} onNewDatabase={() => void newDatabase()} onImport={() => setImporting("pick")} />;
  }

  return (
    <div className="shell" data-testid="based-root" data-ready={state.ready ? "" : undefined}>
      <Sidebar client={client} state={state} route={route} homePage={homePage} onHome={goHome} onNavigate={navigate} onOpenPage={openPage} onNewPage={newPage} onQuickFind={() => setQuickFind(true)} onImportStatus={() => setImporting("notion")} advanced={appearance.agentDetails} ai={ai} />
      <main className="main">
        <TabBar history={history} titles={state.titles} />
        <div className="panel" onScroll={keepPanelStill}><Suspense fallback={<div className="screen-loading" role="status" aria-label="Loading" />}>{screen}</Suspense></div>
        <div ref={swipeHint} className="swipe-hint" aria-hidden="true" data-side="">
          <span className="swipe-back"><Icon name="back" size={18} /></span>
          <span className="swipe-forward"><Icon name="forward" size={18} /></span>
        </div>
      </main>
      {ai ? <Suspense fallback={null}><ChatDock client={client} history={history} route={route} /></Suspense> : null}
      <Notice notice={state.notice} onDismiss={client.dismissNotice} />
      <PromptHost />
      {palette ? <NewPalette commands={commands} onClose={() => setPalette(false)} /> : null}
      <DevOverlay />
      {sheet ? <ShortcutSheet ai={ai} onClose={() => setSheet(false)} /> : null}
      <ShortcutHud ai={ai} />
      <ReportProblemDialog onOpenDiagnostics={() => history.navigate({ name: "settings", page: "diagnostics" })} />
      <TrashUndo client={client} onOpenPage={openPage} />
      {importing ? <ImportDialog client={client} initial={importing} onClose={() => setImporting(false)} onOpenPage={openPage} /> : null}
      {pick ? <QuickFind client={client} titles={state.titles} recent={recent} onOpen={(id) => pick.resolve(id)} onClose={() => pick.resolve(undefined)} /> : null}
      {quickFind ? <QuickFind client={client} titles={state.titles} recent={recent} currentPage={route.name === "page" ? { id: route.id, title: state.titles.get(route.id) || "Untitled" } : undefined} onOpen={(id) => { setQuickFind(false); openPage(id); }} onClose={() => setQuickFind(false)}
        onCommand={(id) => {
          setQuickFind(false);
          if (!commandVisible(id)) return;
          if (id === "meeting") void newMeeting();
          else if (id === "home") goHome();
          else if (id === "dashboard") navigate({ name: "home" });
          else if (id === "report") void startReport();
          else if (id === "shortcuts") setSheet(true);
          else if (id === "welcomeTour") welcomeTour.show();
          else if (id === "chat" || id === "tasks" || id === "coding" || id === "graph" || id === "meetings" || id === "library" || id === "trash" || id === "settings") navigate({ name: id });
        }} /> : null}
    </div>
  );
}

/** Die Inhaltsfläche rollt nur senkrecht: ein seitlicher Versatz (Trackpad, scrollIntoView, Code) wird sofort,
 *  noch vor dem Zeichnen, zurückgesetzt. */
function keepPanelStill(e: { currentTarget: HTMLElement }) {
  if (e.currentTarget.scrollLeft !== 0) e.currentTarget.scrollLeft = 0;
}
