// BSD-551 (Mac-Beta): der geführte Einstieg beim ersten Start – welche Schritte es gibt und was darin steht. Reine
// Daten (getestet in welcomeTourSteps.test.ts), die Darstellung liegt in WelcomeTour.tsx. Texte englisch und kurz, ohne
// Gedankenstriche. Kein Wort über AI: auf beta gibt es sie nicht, und der Einstieg ist für Tester.
import type { IconName } from "../icons.js";
import type { TourStepID } from "../shell/firstRun.js";

export interface TourEnv {
  /** Mac-App (Tauri): Menü, Updates, Sicherung vor dem Update, lokaler Server für Backups und Meeting-Notizen */
  mac: boolean;
  /** Schritt „Meeting notes“ zeigen (Mac-App und Meetings auf diesem Kanal nicht ausgeblendet) */
  meetings: boolean;
  /** erneut geöffnet (Hilfe → Show Welcome Tour): ohne die Wahl am Ende, legt nichts an */
  revisit?: boolean;
}

export interface TourPoint {
  icon: IconName;
  title: string;
  text: string;
  /** Tastenkürzel in der Schreibweise des Registers („Mod+K“), als Tastenkappe neben dem Titel */
  keys?: string;
}

export interface TourStepText {
  title: string;
  lead: string;
  points: TourPoint[];
}

/** Die Schritte in Reihenfolge. Wiederaufruf: ohne „start“. */
export function tourSteps(env: TourEnv): TourStepID[] {
  return (["welcome", "data", "meetings", "beta", "start"] as const).filter((s) =>
    (s !== "meetings" || env.meetings) && (s !== "start" || !env.revisit));
}

/** Nächster bzw. voriger Schritt; am Rand bleibt es stehen. Unbekannter Schritt (z. B. Meetings jetzt ausgeblendet): Anfang. */
export function stepAfter(steps: readonly TourStepID[], at: TourStepID, delta: 1 | -1): TourStepID {
  const i = steps.indexOf(at);
  if (i < 0) return steps[0]!;
  return steps[Math.min(steps.length - 1, Math.max(0, i + delta))]!;
}

/** Wo „Skip“ hinführt: beim ersten Start zur Wahl, beim Wiederaufruf schließt er (undefined). */
export function skipTarget(env: TourEnv): TourStepID | undefined {
  return env.revisit ? undefined : "start";
}

export function tourStepText(step: Exclude<TourStepID, "start">, env: TourEnv): TourStepText {
  const place = env.mac ? "this Mac" : "this device";
  switch (step) {
    case "welcome":
      return {
        title: "Welcome to Based Notes",
        lead: `A workspace for notes, pages and databases. It runs on ${place} and needs no account.`,
        points: [
          { icon: "page", title: "Pages are made of blocks", keys: "/", text: "Type / on an empty line to add a heading, a to-do, an image or a database." },
          { icon: "database", title: "Databases", text: "Collect pages with properties and see them as a table, board, list or calendar." },
          { icon: "search", title: "Find anything", keys: "Mod+K", text: "Search every page and run commands from one place." },
        ],
      };
    case "data":
      return {
        title: `Your data stays on ${place}`,
        lead: `No account and no server. Your workspace is a file on ${place}, and nothing leaves it unless you ask.`,
        points: [
          ...(env.mac ? [
            { icon: "history", title: "A copy before every update", text: "Based saves your whole workspace before it installs an update." },
            { icon: "sync", title: "Hourly backups", text: "Turn on the local server in Settings → Sync & server and let this app sync with it. Based then backs up every hour and when you quit, to a folder you choose." },
          ] satisfies TourPoint[] : []),
          { icon: "export", title: "Export any time", text: "Export a page or the whole workspace as Markdown, HTML or a Based archive." },
        ],
      };
    case "meetings":
      return {
        title: "Meeting notes",
        lead: "Record a meeting, take notes while it runs and get a transcript. Recording and transcript stay on this Mac.",
        points: [
          { icon: "mic", title: "Start on any page", keys: "/", text: "Type /meet and press Start. After Stop you get the transcript; click a line to hear that moment." },
        ],
      };
    case "beta":
      return {
        title: "This is a beta",
        lead: "Most of Based is here and some things are still missing. Keep a copy of anything you can’t afford to lose.",
        points: [
          { icon: "check", title: "In this beta", text: `${list(["Pages", "databases", "import from Notion and other apps", "export", env.mac ? "tabs and windows" : "tabs", ...(env.meetings ? ["meeting notes"] : [])])}.` },
          { icon: "close", title: "Not yet", text: env.mac
            ? "The iPhone app and sharing. Sync between your Macs works only through an iCloud Drive folder for now."
            : "The iPhone app and sharing." },
          { icon: "inbox", title: "Tell us what breaks", keys: "Mod+Shift+B", text: env.mac
            ? "Help → Report a Problem saves a report, or write to hello@basednotes.app."
            : "This saves a report, or write to hello@basednotes.app." },
          ...(env.mac ? [{ icon: "restore", title: "Updates", text: "Based checks for updates on its own and asks before it installs one." } satisfies TourPoint] : []),
        ],
      };
  }
}

/** „a, b and c“ */
function list(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
