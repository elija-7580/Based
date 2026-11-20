// BSD-275 (Mac-Beta): Willkommensbildschirm beim ersten Start ohne Konto. Zwei Wege: aus Notion importieren (öffnet den
// Import-Dialog mit „Connect Notion directly“, BSD-217/317) oder leer starten. Beide legen die kurzen Anleitungsseiten
// unter „Welcome to Based“ an (worker/welcomeGuides.ts). AI bleibt aus; „Turn on agents“ führt nur zu Einstellungen →
// Agents (BSD-228), ohne den Willkommensbildschirm zu beenden. Steht an Stelle von Home, solange firstRun aussteht.
// BSD-436: dritter Weg „Start from a template“ – Tasks, Notes, Journal, Wiki (@based/core STARTER_TEMPLATES); legt die
// Vorlage oben unter Private an (dazu die Anleitungsseiten) und öffnet sie.
// BSD-551: davor der Einstieg in Schritten (WelcomeTour.tsx); die Wahl hier ist dessen letzter Schritt „start“. Die
// Zeile „Meeting notes“ steht jetzt im Schritt „Meeting notes“.
import { AI_OPTION } from "../shell/ai.js";
import { BasedButton } from "@based/ui/astryx";
import { STARTER_TEMPLATES, type StarterTemplateID } from "@based/core";
import { useEffect, useRef, useState, type Ref } from "react";
import { Icon, type IconName } from "../icons.js";
import type { Route } from "../shell/router.js";
import { firstRun, type WelcomePending } from "../shell/firstRun.js";
import { keyLabel } from "../shell/keyHints.js";
import type { StoreClient } from "../worker/client.js";
import { WELCOME_GUIDES } from "../worker/welcomeGuides.js";
import { TourProgress, TourStep, lastInputWasPointer, tourEnv } from "./WelcomeTour.js";
import { stepAfter, tourSteps } from "./welcomeTourSteps.js";
import "./welcome.css";

export { meetingNotesOptionText } from "./WelcomeTour.js";

interface Props {
  client: StoreClient;
  pending: WelcomePending;
  onOpenPage: (id: string) => void;
  onNavigate: (r: Route) => void;
  onImport: () => void;
}

type Way = "notion" | "empty" | StarterTemplateID;

/** Eine Wahl als Karte (Kachel, Titel, Beschreibung); ohne Beschreibung kompakt (die Vorlagen). */
function Choice({ icon, title, description, disabled, onChoose, buttonRef }: {
  icon: IconName; title: string; description?: string; disabled: boolean; onChoose: () => void; buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button ref={buttonRef} type="button" className={description ? "welcome-choice" : "welcome-choice compact"} disabled={disabled} onClick={onChoose}>
      <span className="tile" aria-hidden="true"><Icon name={icon} size={description ? 20 : 18} /></span>
      <span className="welcome-choice-text">
        <strong>{title}</strong>
        {description ? <span className="t-desc">{description}</span> : null}
      </span>
    </button>
  );
}

export function Welcome(props: Props) {
  const env = tourEnv();
  const steps = tourSteps(env);
  // Merker aus 0.2.x (ohne Schritt) und ein Schritt, den es hier nicht gibt, landen bei der Wahl bzw. am Anfang.
  const at = props.pending.step && steps.includes(props.pending.step) ? props.pending.step : props.pending.step ? steps[0]! : "start";
  if (at !== "start") {
    return (
      <div className="content welcome" data-testid="welcome">
        <div className="column">
          <TourStep key={at} step={at} env={env} onGo={(s) => firstRun.setStep(s)} onNavigate={props.onNavigate} />
        </div>
      </div>
    );
  }
  return <WelcomeStart {...props} back={props.pending.step ? () => firstRun.setStep(stepAfter(steps, "start", -1)) : undefined} />;
}

/** Letzter Schritt: wie möchtest du anfangen? */
function WelcomeStart({ client, pending, onOpenPage, onNavigate, onImport, back }: Props & { back: (() => void) | undefined }) {
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  // BSD-620: Fokus auf der ersten Wahl (Return wählt sie); kam man mit der Maus hierher, ohne Rahmen, bis eine Taste kommt.
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    setQuiet(lastInputWasPointer());
    first.current?.focus({ preventScroll: true });
  }, []);
  const steps = tourSteps(tourEnv());

  const guides = () => client.command<string[]>({ op: "addWelcomeGuides", parent: pending.page }).catch(() => [] as string[]);

  const choose = async (how: Way) => {
    if (busy) return;
    setBusy(true);
    await guides();
    const made = how === "notion" || how === "empty" ? undefined
      : await client.command<string | undefined>({ op: "addStarterTemplate", template: how }).catch(() => undefined);
    firstRun.done();
    if (how === "notion") onImport();
    else onOpenPage(made ?? pending.page);
  };

  return (
    <div className="content welcome" data-testid="welcome">
      <div className="column" data-testid="tour-step" data-step="start" data-quiet-focus={quiet ? "" : undefined} onKeyDown={() => setQuiet(false)}>
        {back ? <TourProgress steps={steps} at="start" /> : null}
        <header className="welcome-head">
          <h1 className="t-title">How do you want to start?</h1>
          <p className="t-desc welcome-lead">Bring your pages over from Notion, start from a template or start empty.</p>
        </header>

        <div className="welcome-choices" role="group" aria-label="How do you want to start?">
          <Choice buttonRef={first} icon="library" title="Import from Notion" description="Pages, databases and relations from your Notion export. Views come along when you connect Notion directly." disabled={busy} onChoose={() => void choose("notion")} />
          <Choice icon="page" title="Start empty" description={`A blank workspace with ${WELCOME_GUIDES.length} short guides: ${guideList()}.`} disabled={busy} onChoose={() => void choose("empty")} />
        </div>

        <section className="welcome-templates" aria-labelledby="welcome-templates-title">
          <h2 id="welcome-templates-title" className="t-meta welcome-templates-title">Or start from a template</h2>
          <div className="welcome-choices compact" role="group" aria-labelledby="welcome-templates-title">
            {STARTER_TEMPLATES.map((t) => (
              <Choice key={t.id} icon={t.icon as IconName} title={t.title} disabled={busy} onChoose={() => void choose(t.id)} />
            ))}
          </div>
        </section>

        {AI_OPTION ? (
        <section className="welcome-ai" aria-labelledby="welcome-ai-title">
          <span className="welcome-choice-text">
            <strong id="welcome-ai-title">AI stays off</strong>
            <span className="t-desc">Agents can write and file pages for you after you turn them on and choose a model.</span>
          </span>
          <BasedButton label="Turn on agents" variant="secondary" onClick={() => onNavigate({ name: "settings", page: "agents" })} />
        </section>
        ) : null}

        <footer className="tour-actions">
          {back ? <BasedButton label="Back" variant="ghost" disabled={busy} onClick={back} /> : null}
          <p className="t-desc welcome-foot">Your workspace is saved on this device. You can import more later with {keyLabel("N")}.</p>
        </footer>
      </div>
    </div>
  );
}

/** „Basics, Databases, Keyboard, Your data and Everything in Based“ */
function guideList(): string {
  const t = WELCOME_GUIDES.map((g) => g.title);
  return t.length < 2 ? t.join("") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`;
}
