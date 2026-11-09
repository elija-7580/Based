// BSD-178: Web-Oberfläche in „Based Default“ – Shell und Prototyp-Screens (Canvas „Based – Design“ v6/v8/v9).
// Inhalte sind Demo-Daten (src/data.ts), bis der Store angeschlossen ist.
import { useEffect, useState } from "react";
import { applyAppearance, loadAppearance, saveAppearance, type Appearance } from "./appearance.js";
import { Sidebar } from "./components/Sidebar.js";
import type { Screen } from "./data.js";
import { Database } from "./screens/Database.js";
import { Graph } from "./screens/Graph.js";
import { Home } from "./screens/Home.js";
import { Page } from "./screens/Page.js";
import { Settings } from "./screens/Settings.js";

// Hash-Namen: schlicht (#home), damit Links auch im claude.ai-Artefakt funktionieren (dort nur #name, und
// „settings“ ist reserviert).
const HASH: Record<Screen, string> = { home: "home", page: "lecture", db: "backlog", graph: "graph", settings: "appearance" };
const fromHash = (): Screen => {
  const h = (globalThis.location?.hash ?? "").replace(/^#\/?/, "");
  return (Object.keys(HASH) as Screen[]).find((s) => HASH[s] === h || s === h) ?? "home";
};

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

export function App() {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
  const [screen, setScreen] = useState<Screen>(fromHash);

  useEffect(() => {
    applyAppearance(appearance);
    saveAppearance(appearance);
    if (appearance.style === "bold") ensureBoldFonts();
  }, [appearance]);

  useEffect(() => {
    const onHash = () => setScreen(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (s: Screen) => {
    window.location.hash = HASH[s];
    setScreen(s);
  };

  return (
    <div className="shell" data-testid="based-root">
      <Sidebar screen={screen} onNavigate={navigate} />
      <main className="main">
        <div className="panel">
          {screen === "home" ? <Home showDetails={appearance.agentDetails} onNavigate={navigate} /> : null}
          {screen === "page" ? <Page /> : null}
          {screen === "db" ? <Database /> : null}
          {screen === "graph" ? <Graph /> : null}
          {screen === "settings" ? <Settings value={appearance} onChange={setAppearance} /> : null}
        </div>
      </main>
    </div>
  );
}
