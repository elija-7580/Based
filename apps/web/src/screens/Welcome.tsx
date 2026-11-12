// BSD-275 (Mac-Beta): Willkommensbildschirm beim ersten Start ohne Konto. Zwei Wege: aus Notion importieren (öffnet den
// Import-Dialog mit „Connect Notion directly“, BSD-217/317) oder leer starten. Beide legen die kurzen Anleitungsseiten
// unter „Welcome to Based“ an (worker/welcomeGuides.ts). AI bleibt aus; „Turn on agents“ führt nur zu Einstellungen →
// Agents (BSD-228), ohne den Willkommensbildschirm zu beenden. Steht an Stelle von Home, solange firstRun aussteht.
import { BasedButton } from "@based/ui/astryx";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons.js";
import type { Route } from "../shell/router.js";
import { firstRun, type WelcomePending } from "../shell/firstRun.js";
import { keyLabel } from "../shell/keyHints.js";
import type { StoreClient } from "../worker/client.js";
import { WELCOME_GUIDES } from "../worker/welcomeGuides.js";
import "./welcome.css";

interface Props {
  client: StoreClient;
  pending: WelcomePending;
  onOpenPage: (id: string) => void;
  onNavigate: (r: Route) => void;
  onImport: () => void;
}

export function Welcome({ client, pending, onOpenPage, onNavigate, onImport }: Props) {
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus({ preventScroll: true }), []);

  const guides = () => client.command<string[]>({ op: "addWelcomeGuides", parent: pending.page }).catch(() => [] as string[]);

  const choose = async (how: "notion" | "empty") => {
    if (busy) return;
    setBusy(true);
    await guides();
    firstRun.done();
    if (how === "notion") onImport();
    else onOpenPage(pending.page);
  };

  return (
    <div className="content welcome" data-testid="welcome">
      <div className="column">
        <header className="welcome-head">
          <h1 className="t-title">Welcome to Based</h1>
          <p className="t-desc welcome-lead">Bring your pages over from Notion or start with an empty workspace. No account needed.</p>
        </header>

        <div className="welcome-choices" role="group" aria-label="How do you want to start?">
          <button ref={first} type="button" className="welcome-choice" disabled={busy} onClick={() => void choose("notion")}>
            <span className="tile" aria-hidden="true"><Icon name="library" size={20} /></span>
            <span className="welcome-choice-text">
              <strong>Import from Notion</strong>
              <span className="t-desc">Pages, databases and views, from an export file or a Notion connection.</span>
            </span>
          </button>
          <button type="button" className="welcome-choice" disabled={busy} onClick={() => void choose("empty")}>
            <span className="tile" aria-hidden="true"><Icon name="page" size={20} /></span>
            <span className="welcome-choice-text">
              <strong>Start empty</strong>
              <span className="t-desc">A blank workspace with {WELCOME_GUIDES.length} short guides: {guideList()}.</span>
            </span>
          </button>
        </div>

        <section className="welcome-ai" aria-labelledby="welcome-ai-title">
          <span className="welcome-choice-text">
            <strong id="welcome-ai-title">AI stays off</strong>
            <span className="t-desc">Agents can write and file pages for you after you turn them on and choose a model.</span>
          </span>
          <BasedButton label="Turn on agents" variant="secondary" onClick={() => onNavigate({ name: "settings", page: "agents" })} />
        </section>

        <p className="t-desc welcome-foot">Your workspace is saved on this device. You can import more later with {keyLabel("N")}.</p>
      </div>
    </div>
  );
}

/** „Basics, Databases, Keyboard and Your data“ */
function guideList(): string {
  const t = WELCOME_GUIDES.map((g) => g.title);
  return t.length < 2 ? t.join("") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`;
}
