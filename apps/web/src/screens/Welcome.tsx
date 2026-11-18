// BSD-275 (Mac-Beta): Willkommensbildschirm beim ersten Start ohne Konto. Zwei Wege: aus Notion importieren (öffnet den
// Import-Dialog mit „Connect Notion directly“, BSD-217/317) oder leer starten. Beide legen die kurzen Anleitungsseiten
// unter „Welcome to Based“ an (worker/welcomeGuides.ts). AI bleibt aus; „Turn on agents“ führt nur zu Einstellungen →
// Agents (BSD-228), ohne den Willkommensbildschirm zu beenden. Steht an Stelle von Home, solange firstRun aussteht.
// BSD-436: dritter Weg „Start from a template“ – Tasks, Notes, Journal, Wiki (@based/core STARTER_TEMPLATES); legt die
// Vorlage oben unter Private an (dazu die Anleitungsseiten) und öffnet sie.
import { AI_OPTION } from "../shell/ai.js";
import { featureVisible } from "../shell/beta.js";
import { isTauri } from "../desktop.js";
import { useTranscriptionSetup } from "../meeting/useTranscription.js";
import { downloadPercent, megabytes, type TranscribeModelChoice, type TranscriptionStep } from "../meeting/whisper.js";
import { BasedButton } from "@based/ui/astryx";
import { STARTER_TEMPLATES, type StarterTemplateID } from "@based/core";
import { useEffect, useRef, useState, type Ref } from "react";
import { Icon, type IconName } from "../icons.js";
import { LogoIntro } from "../components/LogoIntro.js";
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

export function Welcome({ client, pending, onOpenPage, onNavigate, onImport }: Props) {
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus({ preventScroll: true }), []);

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
      <div className="column">
        <header className="welcome-head">
          {/* Elija 17.11.: das Zeichen tippt sich beim ersten Start einmal (components/LogoIntro.tsx) */}
          <LogoIntro />
          <h1 className="t-title">Welcome to Based</h1>
          <p className="t-desc welcome-lead">Bring your pages over from Notion, start from a template or start with an empty workspace. No account needed.</p>
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

        {isTauri() && featureVisible("meetings") ? <MeetingNotesOption /> : null}

        {AI_OPTION ? (
        <section className="welcome-ai" aria-labelledby="welcome-ai-title">
          <span className="welcome-choice-text">
            <strong id="welcome-ai-title">AI stays off</strong>
            <span className="t-desc">Agents can write and file pages for you after you turn them on and choose a model.</span>
          </span>
          <BasedButton label="Turn on agents" variant="secondary" onClick={() => onNavigate({ name: "settings", page: "agents" })} />
        </section>
        ) : null}

        <p className="t-desc welcome-foot">Your workspace is saved on this device. You can import more later with {keyLabel("N")}.</p>
      </div>
    </div>
  );
}

/** Reine Texte (getestet): Titel und Beschreibung der Wahl „Meeting notes“ je Stand. */
export function meetingNotesOptionText(step: TranscriptionStep, o: { model?: Pick<TranscribeModelChoice, "size" | "loaded"> | undefined; problem?: string | undefined } = {}): { title: string; text: string } {
  const problem = o.problem ? ` ${o.problem}` : "";
  switch (step) {
    case "downloading": {
      const pct = o.model ? downloadPercent({ source: "catalog", installed: false, ...o.model }) : undefined;
      return { title: "Meeting notes are turning on", text: `Downloading the speech model${o.model?.size ? ` (${megabytes(o.model.size)})` : ""}…${pct === undefined ? "" : ` ${pct} %.`} You can start now; it continues in the background.` };
    }
    case "ready":
      return { title: "Meeting notes are on", text: "Type /meet on any page to record a meeting and get a transcript, made on this Mac." };
    case "no-engine":
      return { title: "Meeting notes", text: `This build of Based can't transcribe on its own yet. You can still record; set up transcription later in Settings → Meeting notes.${problem}` };
    default:
      return { title: "Meeting notes are off", text: `Record meetings and get a transcript, made on this Mac. Turning this on downloads a speech model once (488 MB) from huggingface.co.${problem}` };
  }
}

/**
 * Elija 17.11.: Meeting notes beim ersten Start einschalten – ein Klick startet den lokalen Server und lädt das
 * Sprachmodell (Balanced). Nur in der Mac-App; der Willkommensbildschirm bleibt stehen, der Download läuft weiter.
 */
function MeetingNotesOption() {
  const t = useTranscriptionSetup();
  const o = meetingNotesOptionText(t.step, { model: t.choice, problem: t.problem });
  return (
    <section className="welcome-ai" aria-labelledby="welcome-meetings-title" data-testid="welcome-meetings" data-step={t.step}>
      <span className="welcome-choice-text">
        <strong id="welcome-meetings-title">{o.title}</strong>
        <span className="t-desc" aria-live="polite">{o.text}</span>
      </span>
      {t.step === "no-server" || t.step === "no-model" ? <BasedButton label="Turn on meeting notes" variant="secondary" busy={t.busy} onClick={t.turnOn} /> : null}
      {t.step === "downloading" ? <BasedButton label="Cancel" variant="ghost" onClick={() => t.act("cancel")} /> : null}
    </section>
  );
}

/** „Basics, Databases, Keyboard and Your data“ */
function guideList(): string {
  const t = WELCOME_GUIDES.map((g) => g.title);
  return t.length < 2 ? t.join("") : `${t.slice(0, -1).join(", ")} and ${t.at(-1)}`;
}
