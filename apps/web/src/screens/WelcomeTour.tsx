// BSD-551 (Mac-Beta, Einstieg 1): geführter Einstieg in Schritten beim ersten Start, vor der Wahl „How do you want to
// start?“ (screens/Welcome.tsx = letzter Schritt). Entscheidung Elija 18.11.: wie Based funktioniert, Daten & Backups,
// Meeting-Notizen, Beta & Feedback. Jeder Schritt mit „Skip“ (springt zur Wahl), Pfeiltasten und Return; Escape wie
// „Skip“. Über Hilfe → „Show Welcome Tour“ (Mac-Menü) oder ⌘K „Welcome tour“ kommt er wieder – dann ohne die Wahl am
// Ende („Done“ führt zurück), es werden keine Daten angefasst.
import { BasedButton, BasedSteps } from "@based/ui/astryx";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AI_OPTION } from "../shell/ai.js";
import { featureVisible } from "../shell/beta.js";
import { isTauri } from "../desktop.js";
import { localServer } from "../desktop/localServer.js";
import { Icon, type IconName } from "../icons.js";
import { keyLabel } from "../shell/keyHints.js";
import { LogoIntro } from "../components/LogoIntro.js";
import { MeetingNotesOption } from "./Welcome.js";
import { tourKey, tourSteps } from "../shell/welcomeTour.js";
import "./welcome.css";

/** „Not yet“ im Beta-Schritt: ohne AI-Schalter (beta) steht AI vorn. */
export function notYetText(ai: boolean): string {
  const parts = [...(ai ? [] : ["AI"]), "the iPhone app", "sync between devices (only through an iCloud folder for now)"];
  const text = `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}.`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** „this Mac“ in der Mac-App, sonst „this device“. */
export function placeName(desktop = isTauri()): string {
  return desktop ? "this Mac" : "this device";
}

interface Props {
  /** „first“: erster Start, danach kommt die Wahl (Schritt 5). „again“: aus dem Hilfe-Menü, endet mit „Done“. */
  mode: "first" | "again";
  /** Fertig oder übersprungen. */
  onFinish: () => void;
}

export function WelcomeTour({ mode, onFinish }: Props) {
  const steps = tourSteps({ meetings: featureVisible("meetings") });
  const total = steps.length + (mode === "first" ? 1 : 0);
  const [index, setIndex] = useState(0);
  const step = steps[index] ?? "basics";
  const last = index === steps.length - 1;
  const primary = useRef<HTMLSpanElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const next = () => (last ? onFinish() : setIndex((i) => i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));

  // Fokus auf „Continue“ bei jedem Schritt: Return geht weiter, Tab erreicht „Skip“ und „Back“.
  useEffect(() => { primary.current?.querySelector("button")?.focus({ preventScroll: true }); root.current?.scrollTo?.({ top: 0 }); }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      // nur im Einstieg selbst (oder ohne Fokus) – in der Seitenleiste gelten deren Tasten
      const target = e.target as HTMLElement | null;
      if (target && target !== document.body && !root.current?.contains(target)) return;
      const act = tourKey(e, target);
      if (!act) return;
      // offene Dialoge (z. B. Ordnerwahl, Problem melden) haben Vorrang
      if ([...document.querySelectorAll<HTMLElement>("dialog[open], [role=dialog]")].some((d) => d.checkVisibility?.() ?? true)) return;
      e.preventDefault();
      if (act === "next") next();
      else if (act === "back") back();
      else onFinish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const place = placeName();
  // Meeting-Notizen sind freiwillig: in der Mac-App heißt „weiter“ dort „Later“ (einschalten geht auch später).
  const nextLabel = last ? (mode === "first" ? "Get started" : "Done") : step === "meetings" && isTauri() ? "Later" : "Continue";

  return (
    <div ref={root} className="content welcome welcome-tour" data-testid="welcome-tour" data-step={step} data-arrow-nav="off">
      <div className="column">
        <BasedSteps count={total} current={index} testID="welcome-tour-steps" />
        {step === "basics" ? (
          <Step title="Welcome to Based Notes" lead={`Notes, pages and databases in one app, saved on ${place}.`} logo>
            <Idea icon="page" title="Everything is a page" text="A page is made of blocks. Type / to add a heading, a list, a table or an image." />
            <Idea icon="database" title="Databases" text="Collect things in a database and look at them as a table, a board or a calendar." />
            <Idea icon="search" title={`${keyLabel("K")} finds everything`} text="Search every page and jump anywhere from one field." />
          </Step>
        ) : step === "data" ? (
          <Step title={`Your data stays on ${place}`} lead={`No account and no server. Your workspace is saved on ${place}.`}>
            {isTauri() ? <BackupIdea /> : null}
            <Idea icon="export" title="Export any time" text="Markdown, HTML or a complete Based archive: Settings → Import → Export workspace." />
          </Step>
        ) : step === "meetings" ? (
          <Step title="Meeting notes" lead={`Record a meeting and get a transcript, made on ${place}. Type /meet on any page to start.`}>
            {isTauri() ? <li><MeetingNotesOption /></li> : <Idea icon="mic" title="Recording" text="Meeting notes record in the Mac app. Turn on transcription in Settings → Meeting notes." />}
          </Step>
        ) : (
          <Step title="This is a beta" lead="Thanks for trying Based early. Some things are still missing, and some will break.">
            <Idea icon="check" title="In the beta" text={`Pages, databases, import from Notion, backups${featureVisible("meetings") ? " and meeting notes" : ""}.`} />
            <Idea icon="more" title="Not yet" text={notYetText(AI_OPTION)} />
            <Idea icon="inbox" title="Tell us what breaks" text={`Press ${keyLabel("B", true)} to report a problem, or write to hello@basednotes.app. Updates install by themselves.`} />
          </Step>
        )}
        <div className="welcome-tour-nav">
          <BasedButton label={mode === "first" ? "Skip" : "Close"} variant="ghost" onClick={onFinish} />
          <span className="welcome-tour-nav-end">
            {index > 0 ? <BasedButton label="Back" variant="secondary" onClick={back} /> : null}
            <span ref={primary} className="welcome-tour-primary"><BasedButton label={nextLabel} variant="primary" onClick={next} /></span>
          </span>
        </div>
      </div>
    </div>
  );
}

function Step({ title, lead, logo = false, children }: { title: string; lead: string; logo?: boolean; children: React.ReactNode }) {
  return (
    <>
      <header className="welcome-head">
        {logo ? <LogoIntro /> : null}
        <h1 className="t-title">{title}</h1>
        <p className="t-desc welcome-lead">{lead}</p>
      </header>
      <ul className="welcome-ideas">{children}</ul>
    </>
  );
}

function Idea({ icon, title, text, children }: { icon: IconName; title: string; text: string; children?: React.ReactNode }) {
  return (
    <li className="welcome-idea">
      <span className="tile" aria-hidden="true"><Icon name={icon} size={20} /></span>
      <span className="welcome-choice-text">
        <strong>{title}</strong>
        <span className="t-desc">{text}</span>
      </span>
      {children}
    </li>
  );
}

/** Backups mit optionaler Ordnerwahl (derselbe Ordnerdialog wie Einstellungen → Backups, BSD-449). */
function BackupIdea() {
  const ls = localServer();
  const s = useSyncExternalStore(ls.subscribe, ls.getState);
  const [message, setMessage] = useState<string>();
  const choose = async () => {
    setMessage(undefined);
    try {
      const dir = await ls.pickBackupDir();
      if (!dir) return;
      await ls.setBackupDir(dir);
      setMessage(`Backups now go to ${dir}.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Idea icon="restore" title="Automatic backups" text={message ?? "Every hour when something changed, when you quit and before every update. You can choose the folder, for example on an external drive."}>
      {s.status === "running" ? <BasedButton label="Choose backup folder…" variant="secondary" onClick={() => void choose()} /> : null}
    </Idea>
  );
}
