// Beta-Gate (Beta-Release-Agent, 16.11.2026): eine zentrale Stelle, die sagt, was ein Build des Kanals „beta“ zeigt.
// Die Beta (Branch `beta`) bekommt nur stabile Funktionen: fertig gebaut und ohne bekannten Bug. Alles andere bleibt im
// Code, ist auf beta aber nirgends sichtbar – nicht in der Seitenleiste, nicht in ⌘K, nicht im Slash-Menü, nicht im
// New-Menü, nicht in den Einstellungen und nicht über alte Links/Tabs. Daten bleiben unberührt: ein vorhandener
// Meeting-Block wird weiter angezeigt, nur neue lassen sich nicht anlegen.
//
// Build-Schalter (vite.config.ts): BASED_CHANNEL=beta → __BASED_CHANNEL__ = "beta". AI hängt zusätzlich am AI-Schalter
// (shell/ai.ts), der auf beta ganz fehlt.
//
// Eine Funktion wieder in die Beta nehmen: Eintrag aus BETA_HIDDEN entfernen (Begründung steht daneben und auf der
// Notion-Seite „Based — Beta-Release“ unter „Entscheidungen“).

declare const __BASED_CHANNEL__: string | undefined;

export type Channel = "dev" | "beta";

/** Kanal dieses Builds. Ohne Build-Schalter (Tests, Entwicklung): "dev". */
export const CHANNEL: Channel = typeof __BASED_CHANNEL__ === "string" && __BASED_CHANNEL__ === "beta" ? "beta" : "dev";

/** Funktionen, die ein Kanal ausblenden kann. */
export type GatedFeature = "meetings" | "graph" | "realtimeText" | "coding" | "sharing" | "agentMarks" | "whiteboard" | "fastStart";

/** Auf beta ausgeblendet, mit Grund (für Menschen; wird nicht angezeigt). */
// Elija 17.11.: Meeting-Notizen sind in der Beta – Aufnahme, Notizen mit Zeit, Transkript auf dem Mac (BSD-453 behoben,
// whisper.cpp liegt der App bei, BSD-231). Die AI-Zusammenfassung bleibt auf beta weg (kein AI-Schalter): der Reiter
// „Summary“ fehlt dort (meeting/host.ts → summaryAvailable). Wieder ausblenden: `meetings: "<Grund>"` hier eintragen.
export const BETA_HIDDEN: Readonly<Partial<Record<GatedFeature, string>>> = {
  graph: "BSD-420: Graph laut Mac-Abnahme buggy und langsam",
  realtimeText: "Echtzeit-Text ist „after“ (features.csv), braucht einen Server",
  coding: "Labs, hängt an AI",
  agentMarks: "BSD-459: Marker-Farbe und Calm mode erklären sich nur über Agenten, die es auf beta nicht gibt",
  // whiteboard: seit 17.11. auf beta sichtbar (Entscheidung Elija: freischalten, sobald Stift und Dateien stehen – BSD-93).
  fastStart: "ADR 0017 Stufe B: Laden nach Bedarf ist ein Versuch; die erste Suche lädt noch den ganzen Workspace",
  sharing: "BSD-460: Teilen ist „after“ (features.csv „Sharing and permissions“), braucht einen Server; docs/beta/README.md",
};

/** Reine Regel (getestet): Ist die Funktion in diesem Kanal sichtbar? */
export function featureVisible(feature: GatedFeature, channel: Channel = CHANNEL): boolean {
  return channel !== "beta" || !(feature in BETA_HIDDEN);
}

/** ⌘K-/Navigationsbefehle und Routen, die an einer Funktion hängen. */
const COMMAND_FEATURE: Readonly<Record<string, GatedFeature>> = {
  meetings: "meetings",
  meeting: "meetings",
  graph: "graph",
  coding: "coding",
  board: "whiteboard",
};

/** Darf ein ⌘K-Befehl bzw. eine Route mit dieser ID in diesem Kanal erscheinen? */
export function commandVisible(id: string, channel: Channel = CHANNEL): boolean {
  const f = COMMAND_FEATURE[id];
  return f === undefined || featureVisible(f, channel);
}

/** Blocktypen, die man in diesem Kanal nicht neu anlegen kann (Slash-Menü). */
export function hiddenBlockTypes(channel: Channel = CHANNEL): ReadonlySet<string> {
  return new Set(featureVisible("meetings", channel) ? [] : ["meeting"]);
}

/**
 * Einstellungsseiten, die auf beta fehlen (Review 16.11.2026, BSD-458): Agents & AI und Connections gehören zu
 * AI/Agenten, My notifications handelt nur von Agenten. BSD-460: die „Not yet“-Seiten ohne eigene Einstellungen
 * (My connections, People, Teamspaces, Security) – Konten, Mitglieder und Freigaben sind nicht in der Beta.
 * Alte Links (#settings/agents) fallen auf Appearance zurück.
 */
export const BETA_HIDDEN_SETTINGS: ReadonlySet<string> = new Set(["agents", "connections", "notifications", "my-connections", "people", "teamspaces", "security"]);

/** Darf die Einstellungsseite mit dieser ID in diesem Kanal erscheinen? */
export function settingsPageVisible(id: string, channel: Channel = CHANNEL): boolean {
  // Die Seite „Meeting notes“ gibt es nur, wo es Meeting-Notizen gibt (sonst wäre sie leer).
  if (id === "meetings" && !featureVisible("meetings", channel)) return false;
  return channel !== "beta" || !BETA_HIDDEN_SETTINGS.has(id);
}

/**
 * Name der App im Kanal (Fenstertitel, Über-Seite, Problem melden). BSD-514: offizieller Name „Based Notes“, die
 * Beta heißt sichtbar „Based Notes Beta“. Nur Anzeige – Kennungen (Bundle-ID, Ports, Discovery-Besitzer, Ordner,
 * CLI `based-beta`) stehen in @based/core desktopPlaces und bleiben, damit Tester Daten und Updates behalten.
 */
export const APP_NAME = CHANNEL === "beta" ? "Based Notes Beta" : "Based";

/** BSD-485/514: Produktname auf der Über-Seite – „Based Notes Beta“ auf beta, sonst „Based Next“. */
export function productName(channel: Channel = CHANNEL): string {
  return channel === "beta" ? "Based Notes Beta" : "Based Next";
}

/** BSD-485: Kurzbeschreibung auf der Über-Seite – auf beta ohne Agenten (die gibt es dort nicht). */
export function productBlurb(channel: Channel = CHANNEL): string {
  return channel === "beta"
    ? "Local-first notes and databases. Your workspace lives on your device."
    : "Local-first notes, databases and agents. Your workspace lives on your device.";
}

/** BSD-483: Hinweis unter Settings → General → Name – Teilen nur nennen, wo es Teilen gibt. */
export function workspaceNameHint(channel: Channel = CHANNEL): string {
  return featureVisible("sharing", channel) ? "Used for exports and shown to people you share with" : "Used for exports";
}

/** BSD-483: Diagnostics → Crash reports → Sending – auf beta der Weg zu uns (BSD-467: Mail an hello@basednotes.app). */
/** Feedback 20. 11.: Satz unter „Copy report“ in Diagnostics → Overview; auf beta der Weg zu uns (wie BSD-483).
 *  BSD-646: zuerst „Send to Based“ (⇧⌘B, BSD-632), Mail als zweiter Weg – wie docs/beta/README.md. */
export function copyReportHint(channel: Channel = CHANNEL): string {
  return channel === "beta"
    ? "Report a Problem (⇧⌘B) sends it to us in one click with Send to Based. Or copy this report and email it to hello@basednotes.app. It holds the state, hangs and log — never page content."
    : "Copy the report and pass it on. It holds the state, hangs and log — never page content.";
}

/** BSD-646: Absturzberichte gehen nicht von selbst raus – der Weg zu uns ist „Send to Based“ (⇧⌘B), dann Mail. */
export function reportSendingHint(channel: Channel = CHANNEL): string {
  return channel === "beta"
    ? "Crash reports are never sent on their own. To reach us, use Report a Problem (⇧⌘B) → Send to Based, or save the report as a file and email it to hello@basednotes.app."
    : "Not available in this beta yet — save the report as a file or copy it and pass it on.";
}
