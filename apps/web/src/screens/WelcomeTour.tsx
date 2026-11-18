// BSD-551 (Mac-Beta): geführter Einstieg in Schritten beim ersten Start – Welcome, Your data, Meeting notes, This is a
// beta, dann die Wahl (screens/Welcome.tsx). Jeder Schritt mit „Skip“, ←/→ und Return (der Weiter-Knopf hat den
// Fokus). Hilfe → „Show Welcome Tour“ (bzw. ⌘K) öffnet ihn erneut, nur zum Lesen (WelcomeTourScreen).
// Nur vorhandene Elemente (docs/design/elements.md): BasedButton, Tastenkappe, Flächen `surface-raised` mit Kachel.
import { BasedButton, BasedKeys } from "@based/ui/astryx";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { LogoIntro } from "../components/LogoIntro.js";
import { isTauri } from "../desktop.js";
import { Icon } from "../icons.js";
import { useTranscriptionSetup } from "../meeting/useTranscription.js";
import { downloadPercent, megabytes, type TranscribeModelChoice, type TranscriptionStep } from "../meeting/whisper.js";
import { featureVisible } from "../shell/beta.js";
import type { TourStepID } from "../shell/firstRun.js";
import type { Route } from "../shell/router.js";
import { skipTarget, stepAfter, tourStepText, tourSteps, type TourEnv } from "./welcomeTourSteps.js";
import "./welcome.css";

/** Umgebung dieses Builds. Ein Test kann den Meeting-Schritt im Browser einschalten (`__basedTourMeetings`). */
export function tourEnv(revisit = false): TourEnv {
  const mac = isTauri();
  const force = (globalThis as { __basedTourMeetings?: unknown }).__basedTourMeetings === true;
  return { mac, meetings: (mac || force) && featureVisible("meetings"), revisit };
}

/** Fortschrittspunkte oben (nur Anzeige, nicht anklickbar). */
export function TourProgress({ steps, at }: { steps: readonly TourStepID[]; at: TourStepID }) {
  const i = steps.indexOf(at);
  return (
    <ol className="tour-dots" aria-label={`Step ${i + 1} of ${steps.length}`} data-testid="tour-progress">
      {steps.map((s) => <li key={s} aria-hidden="true" {...(s === at ? { "aria-current": "step" as const } : {})} />)}
    </ol>
  );
}

interface StepProps {
  step: Exclude<TourStepID, "start">;
  env: TourEnv;
  /** zu einem anderen Schritt (Weiter, Zurück, Skip beim ersten Start) */
  onGo: (s: TourStepID) => void;
  /** nur Wiederaufruf: schließen */
  onClose?: () => void;
  onNavigate: (r: Route) => void;
}

/** Ein Schritt des Einstiegs (alles außer der Wahl am Ende). */
export function TourStep({ step, env, onGo, onClose, onNavigate }: StepProps) {
  const steps = tourSteps(env);
  const t = tourStepText(step, env);
  const root = useRef<HTMLElement>(null);
  const first = steps[0] === step;
  const last = steps.at(-1) === step;
  const next = () => (env.revisit && last ? onClose?.() : onGo(stepAfter(steps, step, 1)));
  const back = () => { if (!first) onGo(stepAfter(steps, step, -1)); };
  const skip = () => { const to = skipTarget(env); if (to) onGo(to); else onClose?.(); };

  // Return drückt „Continue“: der Knopf hat nach jedem Schrittwechsel den Fokus.
  useEffect(() => { root.current?.querySelector<HTMLElement>(".tour-next button")?.focus({ preventScroll: true }); }, [step]);

  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
    if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    else if (e.key === "Escape" && env.revisit) { e.preventDefault(); onClose?.(); }
  };

  return (
    <section ref={root} className="welcome-tour" aria-labelledby="tour-title" data-testid="tour-step" data-step={step} data-arrow-nav="off" onKeyDown={onKey}>
      <TourProgress steps={steps} at={step} />
      <header className="welcome-head">
        {step === "welcome" ? <LogoIntro /> : null}
        <h1 id="tour-title" className="t-title">{t.title}</h1>
        <p className="t-desc welcome-lead">{t.lead}</p>
      </header>
      {step === "meetings" ? <MeetingNotesOption /> : null}
      <ul className="tour-points">
        {t.points.map((p) => (
          <li key={p.title} className="tour-point">
            <span className="tile" aria-hidden="true"><Icon name={p.icon} size={20} /></span>
            <span className="welcome-choice-text">
              <span className="tour-point-title"><strong>{p.title}</strong>{p.keys ? <BasedKeys keys={p.keys} /> : null}</span>
              <span className="t-desc">{p.text}</span>
            </span>
          </li>
        ))}
      </ul>
      {step === "data" && env.mac ? (
        <span className="tour-extra"><BasedButton label="Set up backups" variant="secondary" onClick={() => onNavigate({ name: "settings", page: "sync" })} /></span>
      ) : null}
      <footer className="tour-actions">
        {first ? null : <BasedButton label="Back" variant="ghost" onClick={back} />}
        <span className="grow" />
        {env.revisit && last ? null : <BasedButton label={env.revisit ? "Close" : "Skip"} variant="ghost" onClick={skip} />}
        <span className="tour-next"><BasedButton label={env.revisit && last ? "Done" : "Continue"} variant="primary" onClick={next} /></span>
      </footer>
    </section>
  );
}

/** Wiederaufruf (Hilfe → Show Welcome Tour, ⌘K): nur lesen, ohne die Wahl am Ende; legt nichts an. */
export function WelcomeTourScreen({ onClose, onNavigate }: { onClose: () => void; onNavigate: (r: Route) => void }) {
  const env = tourEnv(true);
  const [step, setStep] = useState<TourStepID>("welcome");
  const s = step === "start" ? "welcome" : step;
  return (
    <div className="content welcome" data-testid="welcome-tour">
      <div className="column">
        <TourStep key={s} step={s} env={env} onGo={setStep} onClose={onClose} onNavigate={onNavigate} />
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
      return { title: "Meeting notes are off", text: `Turning them on downloads a speech model once (488 MB) from huggingface.co. You can also do this later in Settings → My settings → Meeting notes.${problem}` };
  }
}

/**
 * Elija 17.11.: Meeting notes beim ersten Start einschalten – ein Klick startet den lokalen Server und lädt das
 * Sprachmodell (Balanced). BSD-551: steht jetzt im Schritt „Meeting notes“; der Download läuft weiter.
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
